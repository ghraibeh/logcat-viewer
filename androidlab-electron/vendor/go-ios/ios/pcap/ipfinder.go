package pcap

import (
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/danielpaulus/go-ios/ios"
	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

type NetworkInfo struct {
	Mac  string
	IPv4 string
	IPv6 string
}

// Direction of a captured frame, from the pcapd packet header's IO byte
// (com.apple.pcapd). Determined empirically against a device with a known IP:
// an outbound unicast from the device's private IP to a public server carries
// io=1, so io=1 is outbound (the device is the source) and io=16 is inbound
// (the device is the destination). Any other value is left unclassified.
const (
	dirOutgoing = 1
	dirIncoming = 16
)

// defaultIPTimeout bounds how long FindIp sniffs for the device's own IP before
// returning its best guess. Overridable via GO_IOS_IP_TIMEOUT (seconds) so the
// caller can trade responsiveness for a better chance of catching a packet.
const defaultIPTimeout = 12 * time.Second

func ipTimeout() time.Duration {
	if s := os.Getenv("GO_IOS_IP_TIMEOUT"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return defaultIPTimeout
}

// FindIp reports the device's own Wi-Fi IP by sniffing its live packet capture
// (com.apple.pcapd — a classic-tier service, so no developer tunnel is needed).
//
// Unlike upstream it does NOT filter packets by the hardware Wi-Fi MAC (which
// fails whenever iOS's default "Private Wi-Fi Address" randomises the MAC per
// network) and it does NOT require an IPv6 address before returning. It instead
// uses each frame's capture direction: on an OUTBOUND frame the device is the
// source, on an INBOUND frame it is the destination. A peer or gateway is never
// the source of the device's outbound traffic nor the destination of what the
// device receives, so it can never be mistaken for the device — the flaw of a
// naive "most-seen private address" scan (a chatty LAN peer would win).
//
// It always returns within a bounded timeout, yielding its best guess (possibly
// empty, e.g. an idle device or one off Wi-Fi) instead of blocking forever.
func FindIp(device ios.DeviceEntry) (NetworkInfo, error) {
	mac, _ := ios.GetWifiMac(device) // best-effort; only populates the Mac field
	return findIp(device, mac, ipTimeout())
}

func findIp(device ios.DeviceEntry, mac string, timeout time.Duration) (NetworkInfo, error) {
	intf, err := ios.ConnectToService(device, "com.apple.pcapd")
	if err != nil {
		return NetworkInfo{}, err
	}
	result := make(chan NetworkInfo, 1)
	go func() {
		result <- scanForIp(intf, mac)
	}()
	select {
	case info := <-result:
		intf.Close()
		return info, nil
	case <-time.After(timeout):
		// Closing the connection unblocks the goroutine's pending Decode; it then
		// reports whatever it gathered so far.
		intf.Close()
		return <-result, nil
	}
}

// scanForIp reads pcapd packets until it has confidently identified the device's
// own address (seen on ≥2 direction-classified frames), or until the connection
// is closed (timeout / EOF), at which point it returns its best guess (empty if
// nothing reached confidence). It deliberately trusts ONLY direction-attributed
// addresses: a "most-seen address" fallback would return a chatty LAN peer's IP
// (peers flood the capture with multicast/broadcast), which is exactly the bug
// this replaces.
func scanForIp(intf ios.DeviceConnectionInterface, mac string) NetworkInfo {
	plistCodec := ios.NewPlistCodec()
	info := NetworkInfo{Mac: mac}
	// Addresses attributed to THE DEVICE via frame direction — the source of an
	// outbound frame or the destination of an inbound one. A peer or gateway can
	// never appear here. The ≥2 threshold also drops the occasional misparsed
	// L2-less frame (its bogus address won't recur).
	dev4 := map[string]int{}
	dev6 := map[string]int{}
	for {
		b, err := plistCodec.Decode(intf.Reader())
		if err != nil {
			info.IPv4 = confident(dev4)
			info.IPv6 = confident(dev6)
			return info
		}
		decoded, err := fromBytes(b)
		if err != nil {
			continue
		}
		iph, packet, err := getPacket(decoded)
		if err != nil || len(packet) == 0 {
			continue
		}
		// Wi-Fi / wired interfaces only (en…). Skip cellular (pdp_ip*), AWDL
		// peer-to-peer (awdl*/llw*), VPN (utun*), loopback (lo*), bridges.
		if !strings.HasPrefix(strings.ReplaceAll(iph.IFName, "\x00", ""), "en") {
			continue
		}
		s4, d4, s6, d6 := packetIPs(packet)
		switch iph.IO {
		case dirOutgoing: // device is the source
			tally(dev4, s4)
			tally(dev6, s6)
		case dirIncoming: // device is the destination
			tally(dev4, d4)
			tally(dev6, d6)
		}
		if ip := confident(dev4); ip != "" {
			info.IPv4 = ip
			info.IPv6 = confident(dev6)
			return info
		}
	}
}

// packetIPs extracts the source/destination IPv4 and IPv6 addresses from a raw
// captured frame (getPacket prepends a synthetic Ethernet header for L2-less
// interfaces, so it always parses from Ethernet).
func packetIPs(p []byte) (s4, d4, s6, d6 string) {
	pkt := gopacket.NewPacket(p, layers.LayerTypeEthernet, gopacket.Default)
	if l := pkt.Layer(layers.LayerTypeIPv4); l != nil {
		if ip, ok := l.(*layers.IPv4); ok {
			s4, d4 = ip.SrcIP.String(), ip.DstIP.String()
		}
	}
	if l := pkt.Layer(layers.LayerTypeIPv6); l != nil {
		if ip, ok := l.(*layers.IPv6); ok {
			s6, d6 = ip.SrcIP.String(), ip.DstIP.String()
		}
	}
	return
}

// usable reports whether s is a real routable unicast address — i.e. a plausible
// device address. Loopback, link-local, multicast, broadcast and the unspecified
// address are excluded.
func usable(s string) bool {
	if s == "" {
		return false
	}
	ip := net.ParseIP(s)
	return ip != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast() && !ip.IsMulticast() && !ip.IsUnspecified() &&
		!ip.Equal(net.IPv4bcast)
}

func tally(counts map[string]int, s string) {
	if usable(s) {
		counts[s]++
	}
}

// confident returns the device's address from the direction-attributed counts.
// Every entry is already a device-only address (peers can't appear), so the only
// noise is the occasional misparsed L2-less frame — which yields a bogus PUBLIC
// address. So an RFC1918 private address (the usual LAN IP) qualifies on a single
// sighting for fast detection, while a public address must be seen twice to rule
// out a one-off misparse. A private candidate always outranks a public one; then
// higher count, then lexicographic for determinism. Empty if nothing qualifies.
func confident(counts map[string]int) string {
	best := ""
	bestScore := 0
	for ip, c := range counts {
		p := net.ParseIP(ip)
		priv := p != nil && p.IsPrivate()
		if !priv && c < 2 {
			continue
		}
		score := c
		if priv {
			score += 1000 // any private LAN address beats any public one
		}
		if score > bestScore || (score == bestScore && (best == "" || ip < best)) {
			bestScore = score
			best = ip
		}
	}
	return best
}
