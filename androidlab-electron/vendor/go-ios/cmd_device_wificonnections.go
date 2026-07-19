package main

import (
	"fmt"

	"github.com/danielpaulus/go-ios/ios"
)

// runWifiConnectionsCommand gets/sets the "Show this device when on Wi-Fi"
// lockdown value (com.apple.mobile.wireless_lockdown/EnableWifiConnections).
// Always prints the resulting state so `enable`/`disable` double as a readback.
func runWifiConnectionsCommand(ctx commandContext) {
	if enable, _ := ctx.Args.Bool("enable"); enable {
		exitIfError("failed enabling wifi connections", ios.SetWifiConnections(ctx.Device, true))
	}
	if disable, _ := ctx.Args.Bool("disable"); disable {
		exitIfError("failed disabling wifi connections", ios.SetWifiConnections(ctx.Device, false))
	}
	enabled, err := ios.GetWifiConnections(ctx.Device)
	exitIfError("failed reading wifi connections state", err)
	fmt.Println(convertToJSONString(map[string]interface{}{"EnableWifiConnections": enabled}))
}
