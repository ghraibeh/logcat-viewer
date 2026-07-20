package com.mobilelabkit.mirror

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * Foreground service that owns the whole sender pipeline for one cast session:
 * MediaProjection → [ScreenEncoder] → a bounded queue → TCP socket to the receiver.
 *
 * A foreground service (typed `mediaProjection` on Android 14) is mandatory to hold a
 * MediaProjection. Per Android 14 we register the projection callback and only call
 * getMediaProjection() *after* we're in the foreground.
 */
class ScreenCaptureService : Service() {

    private var projection: MediaProjection? = null
    private var encoder: ScreenEncoder? = null
    private var audioCapturer: AudioCapturer? = null
    private var socket: Socket? = null
    private var out: DataOutputStream? = null
    private var writer: Thread? = null
    private var controlReader: Thread? = null
    @Volatile private var running = false
    private var withAudio = false
    private var muteWhileCasting = true
    private var savedVolume = -1

    // Small bounded queue keeps latency low (≈ depth ÷ fps). On video overflow we don't drop
    // mid-GOP P-frames (that corrupts H.264 until the next keyframe) — instead we flush the
    // backlog and ask the encoder for a fresh IDR, dropping until it arrives. Config never
    // dropped; audio may drop (no inter-frame deps).
    private val queue = LinkedBlockingDeque<MirrorProtocol.Frame>(6)
    @Volatile private var droppingUntilKeyframe = false
    private val main = Handler(Looper.getMainLooper())

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.i(TAG, "MediaProjection stopped by system/user")
            teardown("Screen capture stopped")
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            teardown(null)
            return START_NOT_STICKY
        }
        if (running) return START_NOT_STICKY

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        val host = intent?.getStringExtra(EXTRA_HOST)
        val port = intent?.getIntExtra(EXTRA_PORT, 0) ?: 0
        val width = intent?.getIntExtra(EXTRA_WIDTH, 0) ?: 0
        val height = intent?.getIntExtra(EXTRA_HEIGHT, 0) ?: 0
        val realW = intent?.getIntExtra(EXTRA_REAL_WIDTH, width) ?: width
        val realH = intent?.getIntExtra(EXTRA_REAL_HEIGHT, height) ?: height
        val dpi = intent?.getIntExtra(EXTRA_DPI, 320) ?: 320
        val bitRate = intent?.getIntExtra(EXTRA_BITRATE, 6_000_000) ?: 6_000_000
        val target = intent?.getStringExtra(EXTRA_TARGET_NAME) ?: host ?: "receiver"
        withAudio = (intent?.getBooleanExtra(EXTRA_WITH_AUDIO, false) ?: false) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        muteWhileCasting = intent?.getBooleanExtra(EXTRA_MUTE, true) ?: true

        if (data == null || host == null || port == 0 || width == 0 || height == 0) {
            Log.e(TAG, "missing start extras"); stopSelf(); return START_NOT_STICKY
        }

        startAsForeground(target)

        val mpm = getSystemService(MediaProjectionManager::class.java)
        val proj = mpm.getMediaProjection(resultCode, data)
        if (proj == null) { teardown("Couldn't obtain screen capture"); return START_NOT_STICKY }
        proj.registerCallback(projectionCallback, main)
        projection = proj
        running = true

        // Socket + encoder off the main thread (connect() blocks).
        Thread({ setupStream(proj, host, port, width, height, realW, realH, dpi, bitRate) }, "mirror-setup").start()
        return START_NOT_STICKY
    }

    private fun setupStream(
        proj: MediaProjection, host: String, port: Int,
        width: Int, height: Int, realW: Int, realH: Int, dpi: Int, bitRate: Int,
    ) {
        try {
            val s = Socket()
            s.tcpNoDelay = true
            // Bound the OS send buffer so a slow link backpressures our app queue quickly
            // (the queue then resyncs via keyframe) instead of hiding seconds of frames in the
            // kernel. Plenty for LAN throughput (bandwidth-delay product is tiny on Wi-Fi).
            runCatching { s.sendBufferSize = 128 * 1024 }
            s.connect(InetSocketAddress(host, port), 8000)
            socket = s
            val dout = DataOutputStream(BufferedOutputStream(s.getOutputStream(), 1 shl 16))
            out = dout
            MirrorProtocol.writeHeader(dout, width, height, realW, realH)

            writer = Thread({ writeLoop(dout) }, "mirror-write").also { it.start() }
            // Reverse channel: live touches from the receiver → inject on this device.
            controlReader = Thread({ controlReadLoop(s) }, "mirror-control-rx").also { it.start() }

            encoder = ScreenEncoder(
                projection = proj, width = width, height = height, dpi = dpi, bitRate = bitRate,
                onUnit = { data, isConfig, isKeyFrame ->
                    val kind = if (isConfig) MirrorProtocol.KIND_CONFIG else MirrorProtocol.KIND_VIDEO
                    enqueue(MirrorProtocol.Frame(data, kind), isKeyFrame)
                },
                onError = { msg -> teardown(msg) },
            ).also { it.start() }

            if (withAudio) {
                audioCapturer = AudioCapturer(
                    projection = proj,
                    onPcm = { pcm, _ -> enqueue(MirrorProtocol.Frame(pcm, MirrorProtocol.KIND_AUDIO)) },
                    onError = { msg -> Log.w(TAG, "audio: $msg (continuing video-only)") },
                ).also { it.start() }
                // We're forwarding audio, so silence THIS phone's speaker (capture is
                // volume-independent — the receiver still gets full audio). Restored on stop.
                if (muteWhileCasting) muteSender()
            }
        } catch (e: Exception) {
            Log.e(TAG, "stream setup failed", e)
            teardown("Couldn't connect to $host:$port — ${e.message}")
        }
    }

    /** Reads live touch events from the receiver and injects them via the accessibility
     *  service (null if the user hasn't enabled it → touches ignored). */
    private fun controlReadLoop(s: Socket) {
        try {
            val cin = DataInputStream(s.getInputStream())
            while (running && !s.isClosed) {
                val t = MirrorProtocol.readTouch(cin)
                MirrorAccessibilityService.instance?.onTouch(t)
            }
        } catch (e: Exception) {
            Log.i(TAG, "control reader ended: ${e.message}")
        }
    }

    private fun enqueue(frame: MirrorProtocol.Frame, isKeyFrame: Boolean = false) {
        if (!running) return
        // Config (SPS/PPS): must never be dropped.
        if (frame.isConfig) { runCatching { queue.putFirst(frame) }; return }
        // While recovering from an overflow, skip video until the fresh keyframe arrives.
        if (droppingUntilKeyframe && frame.kind == MirrorProtocol.KIND_VIDEO && !isKeyFrame) return
        if (isKeyFrame) droppingUntilKeyframe = false
        if (queue.offerLast(frame)) return
        // Queue full — the link can't keep up.
        if (frame.kind == MirrorProtocol.KIND_VIDEO && !isKeyFrame) {
            // Don't corrupt the GOP by dropping a P-frame: flush the backlog, ask the encoder
            // for a new IDR, and skip video until it lands (clean resync instead of artifacts).
            queue.clear()
            encoder?.requestKeyFrame()
            droppingUntilKeyframe = true
        } else {
            // Keyframe or audio (no inter-frame deps): drop the oldest to make room.
            queue.pollFirst()
            queue.offerLast(frame)
        }
    }

    private fun writeLoop(dout: DataOutputStream) {
        try {
            while (running) {
                val f = queue.pollFirst(200, TimeUnit.MILLISECONDS) ?: continue
                MirrorProtocol.writeUnit(dout, f.data, 0, f.data.size, f.kind)
                if (queue.isEmpty()) dout.flush()
            }
        } catch (e: InterruptedException) {
            // shutting down
        } catch (e: Exception) {
            Log.i(TAG, "write loop ended: ${e.message}")
            teardown(null) // receiver went away
        }
    }

    private fun muteSender() {
        runCatching {
            val am = getSystemService(AudioManager::class.java) ?: return
            savedVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC)
            am.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0) // flag 0 = no volume UI
            Log.i(TAG, "muted sender media volume (was $savedVolume)")
        }.onFailure { Log.w(TAG, "could not mute (DND policy?): ${it.message}") }
    }

    private fun restoreVolume() {
        if (savedVolume < 0) return
        runCatching {
            val am = getSystemService(AudioManager::class.java) ?: return
            am.setStreamVolume(AudioManager.STREAM_MUSIC, savedVolume, 0)
            Log.i(TAG, "restored sender media volume to $savedVolume")
        }
        savedVolume = -1
    }

    private fun startAsForeground(target: String) {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "Screen cast", NotificationManager.IMPORTANCE_LOW)
            nm.createNotificationChannel(ch)
        }
        val notif: Notification = notificationBuilder()
            .setContentTitle("Casting your screen")
            .setContentText("Mirroring to $target")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            // Playback capture goes through AudioRecord, so the session also needs the
            // microphone FGS type when we're forwarding audio.
            if (withAudio) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            startForeground(NOTIF_ID, notif, type)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    @Suppress("DEPRECATION")
    private fun notificationBuilder(): Notification.Builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
        else Notification.Builder(this)

    private fun teardown(errorOrNull: String?) {
        if (!running && projection == null) { stopSelfSafely(); return }
        running = false
        errorOrNull?.let { Log.w(TAG, "teardown: $it") }
        writer?.interrupt(); writer = null
        controlReader?.interrupt(); controlReader = null
        audioCapturer?.stop(); audioCapturer = null
        restoreVolume()
        encoder?.stop(); encoder = null
        runCatching { projection?.unregisterCallback(projectionCallback) }
        runCatching { projection?.stop() }
        projection = null
        runCatching { out?.close() }
        runCatching { socket?.close() }
        out = null; socket = null
        queue.clear()
        val cb = onStopped
        main.post { cb?.invoke(errorOrNull) }
        stopSelfSafely()
    }

    private fun stopSelfSafely() {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else @Suppress("DEPRECATION") stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (running) teardown(null)
    }

    companion object {
        private const val TAG = "mirror-capture"
        private const val CHANNEL = "mirror_cast"
        private const val NOTIF_ID = 42

        const val ACTION_START = "com.mobilelabkit.mirror.START"
        const val ACTION_STOP = "com.mobilelabkit.mirror.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_WIDTH = "width"
        const val EXTRA_HEIGHT = "height"
        const val EXTRA_REAL_WIDTH = "realWidth"
        const val EXTRA_REAL_HEIGHT = "realHeight"
        const val EXTRA_DPI = "dpi"
        const val EXTRA_BITRATE = "bitrate"
        const val EXTRA_TARGET_NAME = "target"
        const val EXTRA_WITH_AUDIO = "withAudio"
        const val EXTRA_MUTE = "muteWhileCasting"

        /** Set by SenderActivity to learn when the session ends (arg = error message or null). */
        @Volatile var onStopped: ((String?) -> Unit)? = null

        fun stop(context: Context) {
            context.startService(Intent(context, ScreenCaptureService::class.java).setAction(ACTION_STOP))
        }
    }
}
