# Android Auto head-unit — provenance & licensing

## Reference / spec

The Android Auto head-unit protocol is implemented from the reverse-engineered reference
**aasdk** (https://github.com/f1xpl/aasdk) and **OpenAuto** by f1xpl. Both are
**GPLv3**. We do not vendor aasdk's C++; we reimplement the protocol natively for Android
(Kotlin + Android USB Host API + `SSLEngine` + `MediaCodec`), but the wire protocol,
message set, and credentials are aasdk's.

## Files taken from aasdk

- `app/src/main/proto/*.proto` — the Android Auto protobuf message definitions
  (`aasdk_proto/`), used verbatim to generate the Java message classes (Phase 2).
- `app/src/main/assets/headunit_cert.pem` + `headunit_key.pem` — the head-unit TLS
  credential from `aasdk/src/Messenger/Cryptor.cpp`. It is a real head-unit certificate
  (subject "JVC Kenwood", issued by "Google Automotive Link"), which is what the phone's
  Android Auto trusts during the SSL handshake. There is no software way to mint a fresh
  one — this is the community-standard cert every open head unit uses.

## Licensing

Because the protocol, protos, and certificate derive from aasdk, the compiled APK is a
**GPLv3** work. If distributed outside the org, honor GPLv3 (offer of corresponding
source, etc.). This is the same posture as the AirPlay receiver (GPL core) — a deliberate
choice, since there is no non-GPL reference for the Android Auto head-unit protocol.

## Not MFi

Unlike CarPlay, Android Auto requires **no** hardware authentication chip. The head-unit
side is TLS (with the cert above) + protobuf over USB/Wi-Fi — which is exactly why this
software-only receiver is possible where a software CarPlay receiver is not.
