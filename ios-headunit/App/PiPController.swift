import AVKit
import AVFoundation

/// Picture-in-Picture for the live AA projection: drives AVPictureInPictureController straight
/// from the projection's AVSampleBufferDisplayLayer (iOS 15+ content source). The projection
/// is live content — the playback delegate reports an infinite, never-paused range and
/// ignores pause/skip.
///
/// With `canStartPictureInPictureAutomaticallyFromInline` the system floats AA into a PiP
/// window on Home/app-switch by itself; combined with the app's `audio` background mode
/// keeping the head-unit session (socket + decode) alive, projection keeps running — so you
/// can glance at another app while AA stays live in the corner and pops back on return.
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

    func pictureInPictureController(_ c: AVPictureInPictureController, setPlaying playing: Bool) {}

    func pictureInPictureControllerTimeRangeForPlayback(_ c: AVPictureInPictureController) -> CMTimeRange {
        CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity) // "live"
    }

    func pictureInPictureControllerIsPlaybackPaused(_ c: AVPictureInPictureController) -> Bool { false }

    func pictureInPictureController(_ c: AVPictureInPictureController,
                                    didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    func pictureInPictureController(_ c: AVPictureInPictureController, skipByInterval skipInterval: CMTime,
                                    completion: @escaping () -> Void) {
        completion() // can't seek a live projection
    }
}
