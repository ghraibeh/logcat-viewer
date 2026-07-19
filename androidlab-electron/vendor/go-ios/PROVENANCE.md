# go-ios — vendored third-party source (patched)

This directory is a **tracked copy of the full go-ios source tree with AndroidLab's
patches already applied**. It is the authoritative source the app's `ios` binary is
built from — `scripts/build-goios.sh` builds this tree directly (no network clone).

- Upstream: https://github.com/danielpaulus/go-ios
- Vendored base: upstream `main` @ `274bc43` ("Merge pull request #767", current
  upstream HEAD at vendoring time, 2026-07-19)
- License: **MIT** (see `LICENSE`; copyright Daniel Paulus)

## Local modifications

The delta vs upstream is exactly `../../patches/goios-androidlab.patch` (frozen at
vendoring time — see "Updating" below). In brief, the patch adds/changes:

- **DDI mount fix** (`ios/imagemounter/`): evaluate the BuildManifest's
  RestoreRequestRules (ported from pymobiledevice3) so the TSS personalization
  request sends correct EPRO/ESEC and Apple stops rejecting with status 94.
- **`ios ip` rewrite** (`ios/pcap/ipfinder.go`): identify the device's Wi-Fi IP from
  pcapd packet *direction* (not the MAC, which Private Wi-Fi Address randomises),
  bounded timeout.
- **`ios sysmontap` enrichment**: per-core CPU + RAM (`per_cpu` / `mem_total_kb` /
  `mem_used_kb`) for the Monitor tab.
- **`ios wificonnections (enable|disable|get)`**: the lockdown value behind Finder's
  "Show this iPhone when on Wi-Fi" — powers the cable-free connection flow.
- **Wi-Fi developer tunnel** over usbmux Network entries (`GOIOS_NETWORK_TUNNEL=1`)
  and the **RemotePairing (RPPairing) cable-free tunnel** (`cmd_device_remotepairing.go`,
  `ios/tunnel/tunnel_wifi.go`) with **classic-services-over-RSD** routing
  (`ios/lockdown_rsd.go` + RSD branches in installationproxy/afc/springboard/
  house_arrest/crashreport/misagent/notificationproxy/diagnostics).
- **Device resolution**: prefer the USB usbmuxd entry when a device is also visible
  over Wi-Fi; synthesize a tunnel-only device from agent tunnel info.
- **`ios list --details` hardening**: one unreachable (stale Wi-Fi) entry degrades to
  empty fields instead of failing the whole listing.
- **Springboard app icons** (`ios/springboard/client.go`): `getIconPNGData` for the
  Apps tab.

## Pruned from upstream (not needed to build)

- `.git/`, `.github/` (VCS + upstream CI)
- `testdata/` (~15 MB of test binaries: signed IPAs, app-signer executables)
- `ios/dtx_codec/fixtures/` (~3 MB of captured DTX dumps, test-only)
- `.env` (upstream commits an `API_KEY=` pair for their own CI service; unused by
  the build and would trip secret scanners here)

Everything else — including `*_test.go` files — is kept verbatim, so most of
`go test ./...` still runs; only tests needing the pruned fixtures fail.

## Building

```bash
bash scripts/build-goios.sh                    # cross-compile all platforms
GOIOS_HOST_ONLY=1 bash scripts/build-goios.sh  # this host only
```

Binaries land in `node_modules/go-ios/dist/<triple>/ios`, where `findGoIos()`
(src/core/goios.ts) picks them up. Go module dependencies are still fetched from the
Go module proxy at build time (pinned by `go.mod`/`go.sum`).

## Updating

**This tree is authoritative.** Edit files here directly; the patch file is a
snapshot of the delta at vendoring time and is NOT auto-synced. To regenerate it
(e.g. before rebasing onto a newer upstream):

```bash
git clone https://github.com/danielpaulus/go-ios /tmp/goios-up && git -C /tmp/goios-up checkout 274bc43
rm -rf /tmp/goios-up/.git
diff -ruN -x .github -x testdata -x fixtures -x PROVENANCE.md /tmp/goios-up vendor/go-ios > /tmp/delta.patch
```

To rebase onto newer upstream: clone the new ref, apply the regenerated delta,
resolve conflicts, re-prune (`.git`, `.github`, `testdata`, `ios/dtx_codec/fixtures`),
replace this directory, and update the base commit noted above.
