import AVKit
import AVFoundation

/// Picture-in-Picture for the live mirror: drives AVPictureInPictureController straight
/// from the receiver's AVSampleBufferDisplayLayer (iOS 15+ content source). The mirror is
/// live content — the playback delegate reports an infinite, never-paused time range and
/// ignores skip/pause requests.
///
/// Auto-start: with `canStartPictureInPictureAutomaticallyFromInline` the system floats the
/// mirror into PiP on Home/app-switch by itself. Combined with the app's background-audio
/// keepalive, the stream keeps decoding through PiP, app switches, and the lock screen.
final class PiPController: NSObject, AVPictureInPictureControllerDelegate,
                           AVPictureInPictureSampleBufferPlaybackDelegate {

    private var controller: AVPictureInPictureController?

    func attach(layer: AVSampleBufferDisplayLayer) {
        guard controller == nil, AVPictureInPictureController.isPictureInPictureSupported() else { return }
        let source = AVPictureInPictureController.ContentSource(
            sampleBufferDisplayLayer: layer, playbackDelegate: self)
        let c = AVPictureInPictureController(contentSource: source)
        c.canStartPictureInPictureAutomaticallyFromInline = true
        c.delegate = self
        controller = c
    }

    func detach() {
        controller?.stopPictureInPicture()
        controller = nil
    }

    // --- live-content playback delegate ---------------------------------------------------

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                    setPlaying playing: Bool) {
        // Live mirror: there is no pause. The system's pause button is a no-op.
    }

    func pictureInPictureControllerTimeRangeForPlayback(
        _ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity) // "live"
    }

    func pictureInPictureControllerIsPlaybackPaused(
        _ pictureInPictureController: AVPictureInPictureController) -> Bool {
        false
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                    didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                    skipByInterval skipInterval: CMTime,
                                    completion completionHandler: @escaping () -> Void) {
        completionHandler() // can't seek a live mirror
    }
}
