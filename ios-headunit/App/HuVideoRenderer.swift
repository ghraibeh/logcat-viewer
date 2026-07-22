import AVFoundation
import AAHeadUnitCore

/// Annex-B H.264 (from AA's video channel) → CMSampleBuffers → AVSampleBufferDisplayLayer.
/// Same engine as the mirror receiver: parse SPS/PPS into a format description, repackage
/// each access unit as AVCC, display immediately (live projection, no PTS pacing). AA sends
/// its SPS/PPS as a CODEC_CONFIG message ahead of the first IDR.
final class HuVideoRenderer {
    let layer = AVSampleBufferDisplayLayer()
    var onVideoSize: ((Int, Int) -> Void)?

    private let queue = DispatchQueue(label: "aahu-render")
    private var format: CMVideoFormatDescription?
    private var lastSize = CGSize.zero

    init() { layer.videoGravity = .resizeAspect }

    func reset() {
        queue.async {
            self.format = nil
            DispatchQueue.main.async { self.layer.flushAndRemoveImage() }
        }
    }

    /// Drop buffered/stale frames (keep the format) so the next keyframe repaints cleanly —
    /// used on return from PiP/background.
    func flush() {
        DispatchQueue.main.async { self.layer.flush() }
    }

    /// Feed one AA video payload. codecConfig = the SPS/PPS blob (CODEC_CONFIG); otherwise a
    /// frame (may itself begin with SPS/PPS on a keyframe, which we also honor).
    func submit(_ annexB: [UInt8], codecConfig: Bool) {
        queue.async {
            if AnnexB.containsNal(type: 7, in: Data(annexB)) { self.buildFormat(Data(annexB)) }
            if codecConfig { return } // config-only message: nothing to render
            self.render(Data(annexB))
        }
    }

    private func buildFormat(_ data: Data) {
        guard let (sps, pps) = AnnexB.parameterSets(from: data) else { return }
        var fmt: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { sp -> OSStatus in
            pps.withUnsafeBytes { pp -> OSStatus in
                let ptrs = [sp.bindMemory(to: UInt8.self).baseAddress!,
                            pp.bindMemory(to: UInt8.self).baseAddress!]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault, parameterSetCount: 2,
                    parameterSetPointers: ptrs, parameterSetSizes: sizes,
                    nalUnitHeaderLength: 4, formatDescriptionOut: &fmt)
            }
        }
        guard status == noErr, let fmt else { return }
        if format != nil { DispatchQueue.main.async { self.layer.flush() } }
        format = fmt
        let dims = CMVideoFormatDescriptionGetDimensions(fmt)
        let size = CGSize(width: Int(dims.width), height: Int(dims.height))
        if size != lastSize { lastSize = size; DispatchQueue.main.async { self.onVideoSize?(Int(dims.width), Int(dims.height)) } }
    }

    private func render(_ data: Data) {
        guard let format else { return }
        let avcc = AnnexB.toAVCC(data)
        guard !avcc.isEmpty else { return }

        var bb: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: avcc.count,
            blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: avcc.count, flags: 0, blockBufferOut: &bb) == kCMBlockBufferNoErr,
            let bb else { return }
        _ = avcc.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: avcc.count) }

        var sample: CMSampleBuffer?
        var size = avcc.count
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .invalid, decodeTimeStamp: .invalid)
        guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: bb,
              formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1,
              sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
              sampleBufferOut: &sample) == noErr, let sample else { return }

        if let att = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) as? [CFMutableDictionary],
           let first = att.first {
            CFDictionarySetValue(first,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        DispatchQueue.main.async {
            if self.layer.status == .failed { self.layer.flush() }
            self.layer.enqueue(sample)
        }
    }
}
