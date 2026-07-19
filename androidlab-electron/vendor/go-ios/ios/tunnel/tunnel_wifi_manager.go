package tunnel

// AndroidLab patch: a persistent manager for cable-free RemotePairing (Wi-Fi)
// tunnels, mirroring pymobiledevice3's tunneld. It browses "_remotepairing._tcp"
// on a slow ticker and keeps one live tunnel per device that is NOT already
// reachable over the cable (usbmux). Its tunnels are exposed to the agent's
// /tunnels + /tunnel/{udid} API via TunnelManager.SetExtraTunnels, so downstream
// commands reach a Wi-Fi-only device transparently — while the working usbmux
// TunnelManager loop stays completely untouched.
//
// Discovery is tunnel-bound by necessity: "_remotepairing._tcp" advertises only
// an opaque per-device GUID (the mDNS instance name), never the UDID, so the UDID
// is learned from an RSD handshake once the tunnel is up (see ConnectToWifiTunnel
// / wifiTunnelUdid). The GUID keys a device across cycles so an already-tunneled
// (or known-cabled) device is skipped without reconnecting.

import (
	"context"
	"sync"
	"time"

	"github.com/danielpaulus/go-ios/ios/golog"
)

const (
	// wifiBrowseTimeout bounds each "_remotepairing._tcp" browse.
	wifiBrowseTimeout = 3 * time.Second
	// wifiConnectTimeout bounds bringing up a single Wi-Fi tunnel.
	wifiConnectTimeout = 20 * time.Second
	// wifiPortBase offsets Wi-Fi userspace listener ports well clear of the
	// usbmux manager's range (basePort + small offset), so they never collide.
	wifiPortBase = 500
)

// WifiTunnelManager maintains RemotePairing (Wi-Fi) tunnels to devices
// discovered over "_remotepairing._tcp".
type WifiTunnelManager struct {
	pm       PairRecordManager
	basePort int
	// isCabled reports a device already reachable over usbmux (so we skip it and
	// let the wired tunnel win). Typically TunnelManager.HasTunnel.
	isCabled func(udid string) bool

	mux         sync.Mutex
	tunnels     map[string]Tunnel    // keyed by device UDID
	addrToUdid  map[string]string    // device link-local addr -> UDID (learned once)
	failedAddrs map[string]time.Time // addr -> last failed connect (backoff)
	portOffset  int
	closed      bool
}

// wifiFailBackoff is how long to wait before re-attempting an address whose last
// connect failed to yield a usable Wi-Fi tunnel. Bounds the reconnect churn for
// a cabled device (whose Wi-Fi RSD handshake collides with its usbmux tunnel and
// yields no UDID) while still letting a genuinely Wi-Fi-only device appear soon.
const wifiFailBackoff = 30 * time.Second

// NewWifiTunnelManager builds a Wi-Fi tunnel manager. pm is the RemotePairing
// identity store; basePort is the agent's tunnel-info port (Wi-Fi listener ports
// derive from it); isCabled reports devices already tunneled over usbmux.
func NewWifiTunnelManager(pm PairRecordManager, basePort int, isCabled func(udid string) bool) *WifiTunnelManager {
	if isCabled == nil {
		isCabled = func(string) bool { return false }
	}
	return &WifiTunnelManager{
		pm:          pm,
		basePort:    basePort,
		isCabled:    isCabled,
		tunnels:     map[string]Tunnel{},
		addrToUdid:  map[string]string{},
		failedAddrs: map[string]time.Time{},
	}
}

// ListTunnels returns the current Wi-Fi tunnels (for TunnelManager.SetExtraTunnels).
func (w *WifiTunnelManager) ListTunnels() []Tunnel {
	w.mux.Lock()
	defer w.mux.Unlock()
	out := make([]Tunnel, 0, len(w.tunnels))
	for _, t := range w.tunnels {
		out = append(out, t)
	}
	return out
}

// Run drives the browse/tunnel loop until ctx is cancelled, then tears down every
// Wi-Fi tunnel. Call it in its own goroutine.
func (w *WifiTunnelManager) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	w.update(ctx) // first pass immediately
	for {
		select {
		case <-ctx.Done():
			w.closeAll()
			return
		case <-ticker.C:
			w.update(ctx)
		}
	}
}

func (w *WifiTunnelManager) nextPort() int {
	w.mux.Lock()
	defer w.mux.Unlock()
	w.portOffset++
	return w.basePort + wifiPortBase + w.portOffset
}

func (w *WifiTunnelManager) update(ctx context.Context) {
	browseCtx, cancel := context.WithTimeout(ctx, wifiBrowseTimeout)
	eps := FindRemotePairingEndpoints(browseCtx)
	cancel()

	// One endpoint per device link-local address. The mDNS instance GUID rotates
	// frequently, so it can't key a device across cycles; the device's link-local
	// IPv6 (fe80::…%iface) is stable while it stays on the Wi-Fi network, so key on
	// that. A multi-interface device yields one entry per interface — the extras
	// resolve to the same UDID and are deduped by UDID once connected.
	byAddr := map[string]RemotePairingEndpoint{}
	for _, ep := range eps {
		if ep.Addr == "" {
			continue
		}
		if _, ok := byAddr[ep.Addr]; !ok {
			byAddr[ep.Addr] = ep
		}
	}

	keep := map[string]bool{} // UDIDs whose Wi-Fi tunnel should survive this cycle
	now := time.Now()
	for addr, ep := range byAddr {
		w.mux.Lock()
		udid, known := w.addrToUdid[addr]
		_, haveTun := w.tunnels[udid]
		lastFail, failed := w.failedAddrs[addr]
		w.mux.Unlock()

		// Device is reachable over the cable → let the usbmux tunnel win; don't
		// keep a Wi-Fi one (any existing one is torn down below).
		if known && w.isCabled(udid) {
			continue
		}
		if known && haveTun {
			keep[udid] = true
			continue
		}
		// Recently failed to yield a usable tunnel (e.g. a cabled device whose
		// Wi-Fi RSD handshake collides with usbmux) → back off before retrying.
		if failed && now.Sub(lastFail) < wifiFailBackoff {
			continue
		}

		// (Re)connect: learn the UDID and bring the tunnel up.
		connectCtx, c := context.WithTimeout(ctx, wifiConnectTimeout)
		t, err := ConnectToWifiTunnel(connectCtx, ep, w.nextPort(), w.pm)
		c()
		if err != nil {
			// ConnectToWifiTunnel already closed its own socket on failure; the
			// returned zero Tunnel has no closer, so don't Close it here.
			golog.Debug("wifi tunnel discovery attempt failed", "module", logModule, "addr", addr, "error", err)
			w.mux.Lock()
			w.failedAddrs[addr] = now
			w.mux.Unlock()
			continue
		}
		if t.Udid == "" {
			_ = t.Close() // tunnel is up but the UDID handshake failed — drop it
			golog.Debug("wifi tunnel discovery: no udid", "module", logModule, "addr", addr)
			w.mux.Lock()
			w.failedAddrs[addr] = now
			w.mux.Unlock()
			continue
		}
		w.mux.Lock()
		w.addrToUdid[addr] = t.Udid
		delete(w.failedAddrs, addr)
		w.mux.Unlock()
		if w.isCabled(t.Udid) {
			_ = t.Close() // cabled after all — cache the addr→UDID and skip
			golog.Debug("wifi discovery: device is cabled, skipping", "module", logModule, "udid", t.Udid)
			continue
		}
		t.Connection = "wifi"
		w.mux.Lock()
		if old, ok := w.tunnels[t.Udid]; ok {
			_ = old.Close()
		}
		w.tunnels[t.Udid] = t
		w.mux.Unlock()
		golog.Info("wifi tunnel established", "module", logModule, "udid", t.Udid, "address", t.Address, "rsdPort", t.RsdPort)
		keep[t.Udid] = true
	}

	// Tear down Wi-Fi tunnels whose device vanished from Wi-Fi or became cabled.
	w.mux.Lock()
	stale := map[string]Tunnel{}
	for udid, t := range w.tunnels {
		if !keep[udid] {
			stale[udid] = t
			delete(w.tunnels, udid)
		}
	}
	w.mux.Unlock()
	for udid, t := range stale {
		golog.Info("stopping wifi tunnel", "module", logModule, "udid", udid)
		_ = t.Close()
	}
}

func (w *WifiTunnelManager) closeAll() {
	w.mux.Lock()
	if w.closed {
		w.mux.Unlock()
		return
	}
	w.closed = true
	all := w.tunnels
	w.tunnels = map[string]Tunnel{}
	w.mux.Unlock()
	for _, t := range all {
		_ = t.Close()
	}
}
