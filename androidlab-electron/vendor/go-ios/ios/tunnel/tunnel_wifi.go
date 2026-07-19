package tunnel

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/danielpaulus/go-ios/ios/golog"
	"github.com/danielpaulus/go-ios/ios/http"
	"github.com/danielpaulus/go-ios/ios/tunnel/tlspsk"
	"github.com/grandcat/zeroconf"
)

// PairOverUSB establishes RemotePairing trust with a USB-connected device: the
// device persists trust for our selfIdentity's Ed25519 key. This is the one-time
// setup a device needs before Wi-Fi verify-pair (ConnectToWifiTunnel) can
// succeed, because Wi-Fi only exposes the verify service — not first-time
// pairing. It connects to the untrusted tunnel service over the USB _remoted RSD
// and runs the same ManualPair handshake; a first pairing shows an on-device
// confirmation prompt. Nothing is persisted locally (verify uses selfIdentity).
func PairOverUSB(ctx context.Context, device ios.DeviceEntry, p PairRecordManager) error {
	addr, err := ios.FindDeviceInterfaceAddress(ctx, device)
	if err != nil {
		return fmt.Errorf("PairOverUSB: find device interface address: %w", err)
	}
	servicePort, err := getUntrustedTunnelServicePort(addr, device)
	if err != nil {
		return fmt.Errorf("PairOverUSB: find untrusted tunnel service port: %w", err)
	}
	conn, err := ios.ConnectTUNDevice(addr, servicePort, device)
	if err != nil {
		return fmt.Errorf("PairOverUSB: connect to tunnel service: %w", err)
	}
	h, err := http.NewHttpConnection(conn)
	if err != nil {
		return fmt.Errorf("PairOverUSB: http2: %w", err)
	}
	xpcConn, err := ios.CreateXpcConnection(h)
	if err != nil {
		return fmt.Errorf("PairOverUSB: remotexpc: %w", err)
	}
	ts := newTunnelServiceWithXpc(xpcConn, h, p)
	if err := ts.ManualPair(); err != nil {
		return fmt.Errorf("PairOverUSB: pair: %w", err)
	}
	return nil
}

// AndroidLab patch: Wi-Fi (cable-free) developer tunnels via RemotePairing.
//
// Upstream go-ios reaches a device's developer services only through the USB
// CDC-NCM ethernet interface (it browses "_remoted._tcp", exposed only over the
// cable — see discover.go) and runs the RemotePairing handshake over RemoteXPC
// (HTTP/2). iOS 17+ devices ALSO advertise "_remotepairing._tcp" over Wi-Fi (the
// service pymobiledevice3's tunneld uses), where the SAME RemotePairing handshake
// runs over a different transport: length-prefixed "RPPairing" JSON packets on
// the raw TCP socket. This file adds that Wi-Fi path — a socket-backed control
// channel (rpPairingConn) satisfies go-ios's xpcConn interface so the entire
// existing handshake + TLS-PSK tunnel + userspace data plane are reused verbatim.

const remotePairingServiceName = "_remotepairing._tcp"

// rpPairingMagic prefixes every RemotePairing control packet on the Wi-Fi socket
// transport (pymobiledevice3's RPPairingPacket: magic + uint16-BE length + JSON).
var rpPairingMagic = []byte("RPPairing")

// asBytes coerces a control-channel value to raw bytes. The RemoteXPC transport
// yields native []byte; the RPPairing (Wi-Fi/JSON) transport carries the same
// binary fields as base64 strings. Accept either so the handshake codec works
// unchanged over both transports.
func asBytes(v interface{}) []byte {
	switch b := v.(type) {
	case []byte:
		return b
	case string:
		if decoded, err := base64.StdEncoding.DecodeString(b); err == nil {
			return decoded
		}
	}
	return nil
}

// rpPairingConn adapts a raw TCP connection to the "_remotepairing._tcp" service
// into go-ios's xpcConn interface. go-ios's control channel builds the full
// RemoteXPC envelope {mangledTypeName, value:{...}} and calls Send; the Wi-Fi
// wire format carries only the inner value as RPPairing-framed JSON, so we strip
// it on send and re-wrap it on receive. json.Marshal base64-encodes []byte just
// like the device expects (matching pymobiledevice3's encoder).
type rpPairingConn struct {
	conn net.Conn
	r    *bufio.Reader
}

func newRpPairingConn(conn net.Conn) *rpPairingConn {
	return &rpPairingConn{conn: conn, r: bufio.NewReader(conn)}
}

func (c *rpPairingConn) Send(data map[string]interface{}, flags ...uint32) error {
	// Unwrap the RemoteXPC envelope: the Wi-Fi transport sends only the inner
	// {message, originatedBy, sequenceNumber}.
	body := data
	if v, ok := data["value"].(map[string]interface{}); ok {
		body = v
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("rpPairingConn.Send: marshal: %w", err)
	}
	if len(payload) > 0xffff {
		return fmt.Errorf("rpPairingConn.Send: payload too large (%d)", len(payload))
	}
	pkt := make([]byte, 0, len(rpPairingMagic)+2+len(payload))
	pkt = append(pkt, rpPairingMagic...)
	pkt = binary.BigEndian.AppendUint16(pkt, uint16(len(payload)))
	pkt = append(pkt, payload...)
	_, err = c.conn.Write(pkt)
	return err
}

func (c *rpPairingConn) ReceiveOnClientServerStream() (map[string]interface{}, error) {
	magic := make([]byte, len(rpPairingMagic))
	if _, err := io.ReadFull(c.r, magic); err != nil {
		return nil, fmt.Errorf("rpPairingConn.Receive: read magic: %w", err)
	}
	if string(magic) != string(rpPairingMagic) {
		return nil, fmt.Errorf("rpPairingConn.Receive: bad magic %q", magic)
	}
	var sz [2]byte
	if _, err := io.ReadFull(c.r, sz[:]); err != nil {
		return nil, fmt.Errorf("rpPairingConn.Receive: read length: %w", err)
	}
	body := make([]byte, binary.BigEndian.Uint16(sz[:]))
	if _, err := io.ReadFull(c.r, body); err != nil {
		return nil, fmt.Errorf("rpPairingConn.Receive: read body: %w", err)
	}
	var inner map[string]interface{}
	if err := json.Unmarshal(body, &inner); err != nil {
		return nil, fmt.Errorf("rpPairingConn.Receive: unmarshal: %w", err)
	}
	// Re-wrap so go-ios's read() finds it under "value".
	return map[string]interface{}{"value": inner}, nil
}

// newTunnelServiceWithSocket builds a tunnelService whose control channel speaks
// the RPPairing framed protocol over a raw socket (Wi-Fi), instead of RemoteXPC
// over HTTP/2 (USB). xpcConn stays nil — the handshake only uses controlChannel,
// cipher, and the io.Closer.
func newTunnelServiceWithSocket(conn net.Conn, pairRecords PairRecordManager) *tunnelService {
	return &tunnelService{
		c:              conn,
		controlChannel: newControlChannelReadWriter(newRpPairingConn(conn)),
		pairRecords:    pairRecords,
	}
}

// RemotePairingEndpoint is one "_remotepairing._tcp" advertisement discovered
// over Wi-Fi: the device's link-local IPv6 (with %zone) and the service port.
// Instance is the mDNS service instance name — an opaque per-device GUID that is
// stable across a device's interfaces and browse cycles, so it keys a device
// before its UDID is known (the UDID only comes from an RSD handshake over the
// tunnel).
type RemotePairingEndpoint struct {
	Addr     string // "<ipv6>%<iface>"
	Port     int
	Instance string // mDNS service instance name (per-device GUID)
}

// FindRemotePairingEndpoints browses "_remotepairing._tcp" on every interface and
// returns the distinct endpoints seen before ctx is done.
func FindRemotePairingEndpoints(ctx context.Context) []RemotePairingEndpoint {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	found := make(chan RemotePairingEndpoint)
	var wg sync.WaitGroup
	for _, iface := range ifaces {
		resolver, err := zeroconf.NewResolver(zeroconf.SelectIfaces([]net.Interface{iface}), zeroconf.SelectIPTraffic(zeroconf.IPv6))
		if err != nil {
			continue
		}
		entries := make(chan *zeroconf.ServiceEntry)
		if err := resolver.Browse(ctx, remotePairingServiceName, "local.", entries); err != nil {
			continue
		}
		wg.Add(1)
		go func(ifaceName string) {
			defer wg.Done()
			for entry := range entries {
				if entry == nil {
					continue
				}
				for _, ip6 := range entry.AddrIPv6 {
					select {
					case found <- RemotePairingEndpoint{Addr: fmt.Sprintf("%s%%%s", ip6.String(), ifaceName), Port: entry.Port, Instance: entry.Instance}:
					case <-ctx.Done():
						return
					}
				}
			}
		}(iface.Name)
	}
	go func() { wg.Wait(); close(found) }()

	seen := map[string]bool{}
	var out []RemotePairingEndpoint
	for {
		select {
		case <-ctx.Done():
			return out
		case ep, ok := <-found:
			if !ok {
				return out
			}
			key := fmt.Sprintf("%s:%d", ep.Addr, ep.Port)
			if !seen[key] {
				seen[key] = true
				out = append(out, ep)
			}
		}
	}
}

// ConnectToWifiTunnel brings up a no-root developer tunnel to a device over Wi-Fi
// via a "_remotepairing._tcp" endpoint. It runs the RemotePairing handshake over
// the RPPairing socket transport (verify-pair against the stored selfIdentity —
// no PIN for an already-paired device), then the TLS-PSK TCP tunnel and the
// gVisor userspace data plane. The tunnel exposes its RSD proxy on
// localhost:ifacePort; Udid is filled from an RSD handshake over the tunnel.
func ConnectToWifiTunnel(ctx context.Context, ep RemotePairingEndpoint, ifacePort int, p PairRecordManager) (Tunnel, error) {
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("[%s]:%d", ep.Addr, ep.Port))
	if err != nil {
		return Tunnel{}, fmt.Errorf("ConnectToWifiTunnel: dial %s:%d: %w", ep.Addr, ep.Port, err)
	}
	ts := newTunnelServiceWithSocket(conn, p)
	if err := ts.ManualPair(); err != nil {
		conn.Close()
		return Tunnel{}, fmt.Errorf("ConnectToWifiTunnel: pair: %w", err)
	}
	tunnelPort, err := ts.createTcpTunnelListener()
	if err != nil {
		conn.Close()
		return Tunnel{}, fmt.Errorf("ConnectToWifiTunnel: create tcp listener: %w", err)
	}
	tunnelAddr := fmt.Sprintf("[%s]:%d", ep.Addr, tunnelPort)
	tcpConn, err := net.Dial("tcp", tunnelAddr)
	if err != nil {
		conn.Close()
		return Tunnel{}, fmt.Errorf("ConnectToWifiTunnel: dial tunnel %s: %w", tunnelAddr, err)
	}
	tlsConn, err := tlspsk.Client(tcpConn, ts.sharedSecret)
	if err != nil {
		conn.Close()
		return Tunnel{}, fmt.Errorf("ConnectToWifiTunnel: tls-psk: %w", err)
	}
	t, err := connectToUserspaceTunnelLockdown(ctx, ios.DeviceEntry{}, tlsConn, ifacePort)
	if err != nil {
		conn.Close()
		return Tunnel{}, fmt.Errorf("ConnectToWifiTunnel: userspace tunnel: %w", err)
	}
	t.UserspaceTUN = true
	t.UserspaceTUNPort = ifacePort
	if udid, err := wifiTunnelUdid(t); err != nil {
		golog.Warn("ConnectToWifiTunnel: could not read udid over tunnel", "module", logModule, "error", err)
	} else {
		t.Udid = udid
	}
	return t, nil
}

// wifiTunnelUdid performs an RSD handshake through the freshly-created userspace
// tunnel to learn the device's UDID.
func wifiTunnelUdid(t Tunnel) (string, error) {
	device := ios.DeviceEntry{
		UserspaceTUN:     true,
		UserspaceTUNHost: "localhost",
		UserspaceTUNPort: t.UserspaceTUNPort,
	}
	rsd, err := ios.NewWithAddrPortDevice(t.Address, t.RsdPort, device)
	if err != nil {
		return "", err
	}
	defer rsd.Close()
	resp, err := rsd.Handshake()
	if err != nil {
		return "", err
	}
	return resp.Udid, nil
}
