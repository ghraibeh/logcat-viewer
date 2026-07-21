# aa-headunit — provenance & licensing

TypeScript port of the Android Auto head-unit protocol stack in this repo's sibling project
[`android-headunit/`](../../../android-headunit/) (Kotlin), which itself derives from two
reverse-engineered GPLv3 references:

- **aasdk** (https://github.com/f1xpl/aasdk) + **OpenAuto** by f1xpl — transport/framing/TLS
  design, and the head-unit TLS credential.
- **headunit-revived** (https://github.com/andreknieriem/headunit-revived) — the modern
  protobuf message set + message flow (aasdk's 2018 messages are too old for Android Auto 1.7+).
  Field numbers in `src/proto.ts` were transcribed from its generated protobuf Java, vendored at
  `android-headunit/app/src/main/java/com/andrerinas/headunitrevived/aap/protocol/proto/`.

Files taken verbatim:

- `assets/headunit_cert.pem` + `assets/headunit_key.pem` — the head-unit TLS credential
  (JVC Kenwood cert, "Google Automotive Link" CA), from aasdk. The phone trusts this during
  the TLS handshake. Key re-shipped as PKCS#8.

## Licensing — GPLv3, kept at arm's length

Because the protocol, message definitions, certificate, and message flow derive from aasdk +
headunit-revived, **this package is GPLv3** (`LICENSE`). It is deliberately structured as a
**standalone helper process**: the AndroidLab Electron app spawns it as a separate process and
talks to it over a thin stdio protocol (H.264/PCM/events out, touch/config in) — the same
arm's-length pattern as the app's other GPL-adjacent helpers. Do not import this package's
modules into the main app's code; only spawn it.

If the app is distributed outside the org, honor GPLv3 for this component (offer of
corresponding source, etc.).

## Not MFi

Unlike CarPlay, Android Auto requires no hardware authentication chip — the head-unit side is
TLS + protobuf, which is why a software-only receiver is possible.
