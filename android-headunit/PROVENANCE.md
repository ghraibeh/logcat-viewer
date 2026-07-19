# Android Auto head-unit — provenance & licensing

## Reference / spec

The Android Auto head-unit protocol here is implemented from two reverse-engineered
references, both **GPLv3**:

- **aasdk** (https://github.com/f1xpl/aasdk) + **OpenAuto** by f1xpl — the original C++
  head-unit stack. Used for the transport/framing/TLS design (Phases 1–2).
- **headunit-revived** (https://github.com/andreknieriem/headunit-revived) — a modern,
  working **Android/Kotlin** head unit. aasdk's 2018 message set is too old for current
  Android Auto (1.7+), so the protocol/message layer was migrated to headunit-revived's
  **modern protos + message flow**.

## Files taken from headunit-revived (vendored)

- `app/src/main/java/com/andrerinas/headunitrevived/aap/protocol/proto/*.java` — the
  **pre-generated modern protobuf Java** (Control/Media/Sensors/Input/Common/…), vendored
  as-is under their original package. We use `protobuf-java` at runtime (not the protoc
  gradle plugin — the protos have duplicate top-level enum names across files that full
  protoc rejects but the committed code handles).
- The discovery-response structure, channel ids, focus/ping message flow, and the
  video-focus watchdog in our Kotlin (`DiscoveryResponse`, `ControlChannel`,
  `MediaChannel`, `SensorChannel`, `InputChannel`) are adapted from headunit-revived's
  `AapControl` / `ServiceDiscoveryResponse`.

## Files taken from aasdk

- `app/src/main/assets/headunit_cert.pem` + `headunit_key.pem` — the head-unit TLS
  credential (JVC Kenwood cert, "Google Automotive Link" CA). The phone trusts this during
  the SSL handshake. Re-shipped as PKCS#8 for Java's KeyFactory.

## Licensing

Because the protocol, protos, certificate, and message flow derive from aasdk +
headunit-revived, the compiled APK is a **GPLv3** work. If distributed outside the org,
honor GPLv3 (offer of corresponding source, etc.). This mirrors the AirPlay receiver
(GPL core): there is no non-GPL reference for the Android Auto head-unit protocol.

## Not MFi

Unlike CarPlay, Android Auto requires **no** hardware authentication chip — the head-unit
side is TLS + protobuf, which is why a software-only receiver is possible.
