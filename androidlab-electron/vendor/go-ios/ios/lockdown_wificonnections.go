package ios

const (
	wirelessLockdownDomain = "com.apple.mobile.wireless_lockdown"
	wifiConnectionsKey     = "EnableWifiConnections"
)

// GetWifiConnections reads whether the device advertises itself to paired hosts
// over Wi-Fi — the same lockdown value behind Finder's "Show this iPhone when
// on Wi-Fi" checkbox. The key is absent until the first toggle; that reads as
// disabled.
func GetWifiConnections(device DeviceEntry) (bool, error) {
	lockDownConn, err := ConnectLockdownWithSession(device)
	if err != nil {
		return false, err
	}
	defer lockDownConn.Close()
	value, err := lockDownConn.GetValueForDomain(wifiConnectionsKey, wirelessLockdownDomain)
	if err != nil {
		return false, err
	}
	switch v := value.(type) {
	case bool:
		return v, nil
	case uint64:
		return v != 0, nil
	case int64:
		return v != 0, nil
	default:
		// nil / unexpected type: the key was never set — Wi-Fi connections are off.
		return false, nil
	}
}

// SetWifiConnections flips the Wi-Fi-connections lockdown value. The device
// must already be paired over USB; once enabled, usbmuxd (macOS/Windows)
// discovers the device on the local network and every usbmux-routed service
// keeps working without the cable.
func SetWifiConnections(device DeviceEntry, enabled bool) error {
	lockDownConn, err := ConnectLockdownWithSession(device)
	if err != nil {
		return err
	}
	defer lockDownConn.Close()
	return lockDownConn.SetValueForDomain(wifiConnectionsKey, wirelessLockdownDomain, enabled)
}
