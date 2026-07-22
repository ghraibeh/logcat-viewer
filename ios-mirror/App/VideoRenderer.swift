import AVFoundation
import UIKit

/// Annex-B H.264 access units → CMSampleBuffers → AVSampleBufferDisplayLayer (hardware
/// decode + display in one). The Swift twin of android-mirror's receiver `VideoDecoder`,
/// carrying over its battle-tested loss policy:
///
/// - The stream's SPS/PPS (KIND_CONFIG) builds the CMVideoFormatDescription; a new config
///   with different parameter sets swaps the format (rotation / encoder rebuild).
/// - Any failure (enqueue error, layer .failed) closes an IDR gate: non-IDR AUs are HELD —
///   the last clean frame stays up instead of smearing — and `onNeedKeyframe` fires so the
///   sender emits a fresh IDR immediately (CTRL_NEED_IDR — we own both ends).
/// - Frames display immediately (no PTS pacing): this is a live mirror, not playback.
final class VideoRenderer {

    let layer = AVSampleBufferDisplayLayer()

    /// Fired (decode queue) when the reference chain broke and the sender should IDR now.
    var onNeedKeyframe: (() -> Void)?
    /// Fired (main) when the coded size changes — used to letterbox/report.
    var onVideoSize: ((Int, Int) -> Void)?

    private let queue = DispatchQueue(label: "mirror-render")
    private var format: CMVideoFormatDescription?
    private var currentSPS: Data?
    private var currentPPS: Data?
    private var awaitingIdr = false
    private var lastSizeReported = CGSize.zero

    init() {
        layer.videoGravity = .resizeAspect
    }

    func reset() {
        queue.async {
            self.format = nil
            self.currentSPS = nil; self.currentPPS = nil
            self.awaitingIdr = false
            DispatchQueue.main.async { self.layer.flushAndRemoveImage() }
        }
    }

    /// Cheap clean-slate after backgrounding/lock: the layer's decode session may have been
    /// invalidated while suspended, so flush it, gate on the next IDR, and ask the sender
    /// for one — the picture recovers in a frame or two instead of smearing or freezing.
    func resync() {
        queue.async {
            self.awaitingIdr = true
            self.onNeedKeyframe?()
            DispatchQueue.main.async { self.layer.flush() }
        }
    }

    func submit(_ annexB: Data, isConfig: Bool) {
        queue.async {
            if isConfig { self.handleConfig(annexB) } else { self.handleFrame(annexB) }
        }
    }

    private func handleConfig(_ data: Data) {
        guard let (sps, pps) = AnnexB.parameterSets(from: data) else { return }
        if sps == currentSPS, pps == currentPPS, format != nil { return } // unchanged
        var fmt: CMVideoFormatDescription?
        let status = sps.withUnsafeBytes { spsPtr -> OSStatus in
            pps.withUnsafeBytes { ppsPtr -> OSStatus in
                let paramSets: [UnsafePointer<UInt8>] = [
                    spsPtr.bindMemory(to: UInt8.self).baseAddress!,
                    ppsPtr.bindMemory(to: UInt8.self).baseAddress!,
                ]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault,
                    parameterSetCount: 2,
                    parameterSetPointers: paramSets,
                    parameterSetSizes: sizes,
                    nalUnitHeaderLength: 4,
                    formatDescriptionOut: &fmt
                )
            }
        }
        guard status == noErr, let fmt else {
            // A config we can't parse leaves us blind — hold frames + ask for a resend
            // (the sender precedes every IDR with a fresh config).
            awaitingIdr = true
            onNeedKeyframe?()
            return
        }
        // New parameter sets invalidate the decoder's reference chain — flush and resync
        // at the IDR the sender always emits right after a config.
        if format != nil { DispatchQueue.main.async { self.layer.flush() } }
        format = fmt
        currentSPS = sps; currentPPS = pps
        let dims = CMVideoFormatDescriptionGetDimensions(fmt)
        let size = CGSize(width: Int(dims.width), height: Int(dims.height))
        if size != lastSizeReported {
            lastSizeReported = size
            DispatchQueue.main.async { self.onVideoSize?(Int(dims.width), Int(dims.height)) }
        }
    }

    private func handleFrame(_ data: Data) {
        guard let format else {
            // No parameter sets yet — can't decode anything; ask for a clean stream start.
            requestResync()
            return
        }
        if awaitingIdr {
            guard AnnexB.containsNal(type: 5, in: data) else { return } // hold until resync
            awaitingIdr = false
        }

        let avcc = AnnexB.toAVCC(data)
        guard !avcc.isEmpty else { return }

        var blockBuffer: CMBlockBuffer?
        let allocStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: avcc.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: avcc.count,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard allocStatus == kCMBlockBufferNoErr, let bb = blockBuffer else { return }
        _ = avcc.withUnsafeBytes { src in
            CMBlockBufferReplaceDataBytes(with: src.baseAddress!, blockBuffer: bb,
                                          offsetIntoDestination: 0, dataLength: avcc.count)
        }

        var sample: CMSampleBuffer?
        var sampleSize = avcc.count
        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: .invalid,
                                        decodeTimeStamp: .invalid)
        let createStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: bb,
            formatDescription: format,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sample
        )
        guard createStatus == noErr, let sample else { return }

        // Live mirror: display as soon as decoded, no clock pacing.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) as? [CFMutableDictionary],
           let first = attachments.first {
            CFDictionarySetValue(
                first,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }

        DispatchQueue.main.async {
            if self.layer.status == .failed {
                self.layer.flush()
                self.queue.async { self.requestResync() }
                return
            }
            self.layer.enqueue(sample)
            if self.layer.status == .failed {
                // The layer rejects further samples after an error until flushed. Flush and
                // gate — the last good frame stays visible while we resync.
                self.layer.flush()
                self.queue.async { self.requestResync() }
            }
        }
    }

    private func requestResync() {
        awaitingIdr = true
        onNeedKeyframe?()
    }
}
