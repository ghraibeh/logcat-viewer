package com.mobilelabkit.airplay

/**
 * Kotlin front door to the native AirPlay receiver (libairplay.so — the vendored RPiPlay
 * core + FairPlay + bonjour_shim mDNS + fdk-aac/miniaudio audio). Video frames come back
 * on [Listener.onVideoFrame] as Annex-B H.264 for [VideoDecoder]; audio is handled
 * entirely in native. A process hosts one receiver (native globals), so this is an object.
 */
object NativeReceiver {
    init { System.loadLibrary("airplay") }

    interface Listener {
        /** Annex-B H.264. isConfig=true => SPS/PPS codec config, else a frame (IDR or P). */
        fun onVideoFrame(data: ByteArray, pts: Long, isConfig: Boolean)
        fun onClientConnected()
        fun onClientDisconnected()
    }

    private external fun nativeStart(
        name: String, width: Int, height: Int, hwHex: String, listener: Listener
    ): Int
    private external fun nativeSetMuted(muted: Boolean)
    private external fun nativeStop()

    @Volatile private var running = false
    val isRunning: Boolean get() = running

    /** Start advertising + listening. Returns the RAOP port (>0) or a negative error. */
    @Synchronized
    fun start(name: String, width: Int, height: Int, hwHex: String, listener: Listener): Int {
        if (running) return -10
        val port = nativeStart(name, width, height, hwHex, listener)
        running = port > 0
        return port
    }

    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        nativeStop()
    }

    fun setMuted(muted: Boolean) {
        if (running) nativeSetMuted(muted)
    }
}
