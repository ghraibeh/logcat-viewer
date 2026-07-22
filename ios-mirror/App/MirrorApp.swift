import SwiftUI

/// MLK Mirror for iOS — the iOS end of android-mirror's MLK1 protocol. One app, two roles
/// (same shape as the Android app's HomeActivity):
///
///   RECEIVE — advertise `_mlkmirror._tcp`, render an Android/iOS sender's screen + audio,
///             and remote-control Android senders by touch.
///   CAST    — pick a receiver, then start a ReplayKit system broadcast: the whole screen
///             is captured by the broadcast extension, H.264-encoded, and streamed.
///
/// Casting caveats vs Android: iOS can't inject touches (incoming CTRL_TOUCH is ignored by
/// design — see ios-realtime-touch-not-possible), and system-wide capture only runs inside
/// a Broadcast Upload Extension, started from the system picker.
@main
struct MirrorApp: App {
    var body: some Scene {
        WindowGroup {
            HomeScreen()
        }
    }
}

struct HomeScreen: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Spacer()
                Image(systemName: "rectangle.on.rectangle")
                    .font(.system(size: 56)).foregroundStyle(.cyan)
                Text("MLK Mirror").font(.largeTitle).bold()
                Text("Screen + audio mirroring between Android and iOS\non your own network — no cast infrastructure.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Spacer()
                NavigationLink {
                    ReceiverScreen()
                } label: {
                    RoleButton(icon: "arrow.down.circle.fill", title: "Receive a screen",
                               subtitle: "Show another device here")
                }
                NavigationLink {
                    SenderScreen()
                } label: {
                    RoleButton(icon: "arrow.up.circle.fill", title: "Cast this screen",
                               subtitle: "Stream this iPhone to a receiver")
                }
                Spacer()
            }
            .padding(24)
        }
    }
}

private struct RoleButton: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 34)).foregroundStyle(.cyan)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(.primary)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }
}
