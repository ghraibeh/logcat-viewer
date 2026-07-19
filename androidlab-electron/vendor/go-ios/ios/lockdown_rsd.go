package ios

import (
	"fmt"
	"os"
)

// AndroidLab patch: reach classic-tier lockdown over the RSD developer tunnel.
//
// Lockdown (GetValues → `ios info`, and everything that reads device values)
// normally runs over usbmux (ConnectLockdownWithSession). A device reachable
// ONLY over a cable-free RemotePairing/Wi-Fi tunnel has no usbmux entry, so that
// path can't reach it. iOS 17+ also exposes lockdown as an RSD service —
// "com.apple.mobile.lockdown.remote.trusted" — over the tunnel. That connection
// is pre-trusted (the tunnel already authenticated the host), so no
// StartSession/SSL handshake is needed: connect via RSD and read values directly.

const lockdownRemoteTrustedShim = "com.apple.mobile.lockdown.remote.trusted"

// useRsdTransport reports whether classic-tier services should be reached over
// the RSD tunnel instead of usbmux. A tunnel-only device (no usbmux entry ⇒
// DeviceID 0) can be reached only that way; GOIOS_FORCE_RSD_LOCKDOWN forces it
// even for a device that is also on usbmux (used to test the RSD path on a cabled
// device). A usbmux device (DeviceID > 0) keeps using usbmux, so nothing about
// the wired path changes.
func useRsdTransport(device DeviceEntry) bool {
	if !device.SupportsRsd() {
		return false
	}
	return device.DeviceID == 0 || os.Getenv("GOIOS_FORCE_RSD_LOCKDOWN") != ""
}

// ConnectToServiceWithRsd connects to a lockdown service, preferring the RSD
// tunnel (the "<serviceName>.shim.remote" variant) when the device is reachable
// only that way (see useRsdTransport), and falling back to plain usbmux
// (ConnectToService) otherwise. This lets a cable-free RemotePairing/Wi-Fi device
// use the classic-tier services (apps, files, diagnostics, icons, prefs, crashes)
// that otherwise require usbmux. AndroidLab patch.
func ConnectToServiceWithRsd(device DeviceEntry, serviceName string) (DeviceConnectionInterface, error) {
	if useRsdTransport(device) {
		return ConnectToShimService(device, serviceName+".shim.remote")
	}
	return ConnectToService(device, serviceName)
}

// connectLockdownOverRsd opens a pre-trusted lockdown connection over the RSD
// tunnel (see lockdownRemoteTrustedShim). RSD check-in is performed by
// ConnectToShimService; the returned connection speaks the lockdown plist
// protocol directly, with no session to start.
func connectLockdownOverRsd(device DeviceEntry) (*LockDownConnection, error) {
	conn, err := ConnectToShimService(device, lockdownRemoteTrustedShim)
	if err != nil {
		return nil, fmt.Errorf("connectLockdownOverRsd: %w", err)
	}
	return NewLockDownConnection(conn), nil
}
