import AVFoundation

/// Runtime permissions the head unit needs.
///
/// - **Microphone**: for the Google Assistant + phone calls while projecting (AA advertises
///   a mic source and opens it on demand). Requested explicitly up front; if denied, video
///   and audio-out still work — only Assistant/calls can't hear.
/// - **Local Network**: iOS prompts automatically on first use of the LAN listener / Bonjour
///   (driven by NSLocalNetworkUsageDescription + NSBonjourServices in Info.plist) — there is
///   no request API to call, so starting the server IS the request.
enum Permissions {
    /// Ask for microphone access (iOS 17 `AVAudioApplication`, older `AVAudioSession`).
    /// Completion runs on the main queue with the final grant state.
    static func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
        let done = { granted in DispatchQueue.main.async { completion(granted) } }
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: done(true)
            case .denied: done(false)
            default: AVAudioApplication.requestRecordPermission(completionHandler: done)
            }
        } else {
            switch AVAudioSession.sharedInstance().recordPermission {
            case .granted: done(true)
            case .denied: done(false)
            default: AVAudioSession.sharedInstance().requestRecordPermission(done)
            }
        }
    }
}
