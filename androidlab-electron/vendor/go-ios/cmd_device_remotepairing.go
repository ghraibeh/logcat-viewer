package main

import (
	"context"
	"fmt"
	"time"

	"github.com/danielpaulus/go-ios/ios/tunnel"
)

// runRemotePairCommand establishes RemotePairing trust with a USB-connected
// device — the one-time setup a device needs before it will accept a cable-free
// Wi-Fi developer tunnel (see ios/tunnel/tunnel_wifi.go). It runs the
// RemotePairing ManualPair handshake over the device's USB RSD; the device then
// persists trust for this host's selfIdentity key, so a later Wi-Fi verify-pair
// (ConnectToWifiTunnel over "_remotepairing._tcp") succeeds without the cable. A
// first pairing shows an on-device confirmation prompt. Nothing device-specific
// is stored locally (verify uses selfIdentity); --pair-record-path holds that
// host identity and defaults to '.'.
//
// AndroidLab patch.
func runRemotePairCommand(ctx commandContext) {
	pairRecordsPath, _ := ctx.Args.String("--pair-record-path")
	if len(pairRecordsPath) == 0 {
		pairRecordsPath = "."
	}
	pm, err := tunnel.NewPairRecordManager(pairRecordsPath)
	exitIfError("failed to create pair record manager", err)

	c, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	err = tunnel.PairOverUSB(c, ctx.Device, pm)
	exitIfError("failed to establish RemotePairing over USB", err)

	fmt.Println(convertToJSONString(map[string]interface{}{
		"udid":   ctx.Device.Properties.SerialNumber,
		"status": "paired",
	}))
}
