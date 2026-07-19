package com.mobilelabkit.headunit

import android.content.Context
import android.graphics.Point
import android.os.Build
import android.view.WindowManager
import com.andrerinas.headunitrevived.aap.protocol.proto.Control

private typealias ResType = Control.Service.MediaSinkService.VideoConfiguration.VideoCodecResolutionType

/**
 * Head-unit display configuration.
 *
 * The user picks **portrait** or **landscape** once (persisted in SharedPreferences); we then
 * auto-detect the receiver's *physical* screen size + density and map it to the nearest standard
 * Android Auto video resolution. The result feeds [DiscoveryResponse] (what we advertise to the
 * phone), the [VideoDecoder] size, the touch-coordinate scale, and the on-screen letterbox.
 *
 * Android Auto only accepts a fixed ladder of resolutions (the [ResType] enum), so "detect the
 * resolution" means: measure the panel, then snap to the closest AA-legal size for that orientation.
 * We advertise H.264-only, so we cap at 1080p (1440p/4K require H.265).
 */
object HeadUnitConfig {

    enum class Orientation { PORTRAIT, LANDSCAPE }

    /** How the projection fills the panel: FIT = keep aspect (letterbox), FILL = stretch to edges. */
    enum class Scaling { FIT, FILL }

    data class VideoConfig(
        val resolution: ResType,
        val width: Int,
        val height: Int,
        val densityDpi: Int,
        val orientation: Orientation
    ) {
        val label: String get() = "${width}×${height} @ ${densityDpi}dpi (${orientation.name.lowercase()})"
    }

    private const val PREFS = "headunit_config"
    private const val KEY_ORIENTATION = "orientation"
    private const val KEY_SCALING = "scaling"
    private const val KEY_WIRELESS = "wireless"
    private const val KEY_DENSITY = "density_dpi"   // 0 = auto
    // Car-screen densities (dpi) — AA UI scale. Higher dpi ⇒ AA treats the panel as smaller ⇒
    // LARGER on-screen elements. The phone's real dpi (~480) is far too large; a car-screen 160
    // was too small on a hand-held panel. ~280 is the comfortable middle for touch use.
    private const val CAR_DENSITY_DPI = 240
    private const val CAR_DENSITY_DPI_HIGH = 280

    /** User-selectable UI-size levels (dpi). Higher = bigger icons/text. 0 = Auto (by resolution). */
    val DENSITY_LEVELS = listOf(0, 200, 240, 280, 320, 360, 400)
    fun densityLabel(dpi: Int): String = when (dpi) {
        0 -> "Auto"
        200 -> "Smallest (200)"
        240 -> "Small (240)"
        280 -> "Medium (280)"
        320 -> "Large (320)"
        360 -> "Extra large (360)"
        400 -> "Largest (400)"
        else -> "$dpi dpi"
    }

    fun savedDensityDpi(ctx: Context): Int =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_DENSITY, 0)

    fun saveDensityDpi(ctx: Context, dpi: Int) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY_DENSITY, dpi).apply()
    }

    fun isConfigured(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(KEY_ORIENTATION)

    fun savedOrientation(ctx: Context): Orientation {
        val s = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ORIENTATION, null)
        return if (s == Orientation.LANDSCAPE.name) Orientation.LANDSCAPE else Orientation.PORTRAIT
    }

    fun saveOrientation(ctx: Context, o: Orientation) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ORIENTATION, o.name).apply()
    }

    /** Default FIT (keep aspect ratio — no stretch). */
    fun savedScaling(ctx: Context): Scaling {
        val s = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SCALING, null)
        return if (s == Scaling.FILL.name) Scaling.FILL else Scaling.FIT
    }

    fun saveScaling(ctx: Context, s: Scaling) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SCALING, s.name).apply()
    }

    /** Wireless AA (Bluetooth + Wi-Fi Direct) — off by default (USB only). */
    fun wirelessEnabled(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_WIRELESS, false)

    fun saveWireless(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_WIRELESS, on).apply()
    }

    /** Physical panel size in pixels (ignores current rotation): (longSide, shortSide-agnostic raw w,h). */
    private fun realScreenSize(ctx: Context): Pair<Int, Int> {
        val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val b = wm.maximumWindowMetrics.bounds
            b.width() to b.height()
        } else {
            val p = Point()
            @Suppress("DEPRECATION") wm.defaultDisplay.getRealSize(p)
            p.x to p.y
        }
    }

    /** Measure the receiver and snap to the nearest AA-legal resolution for [orientation]. */
    fun detect(ctx: Context, orientation: Orientation): VideoConfig {
        val (rw, rh) = realScreenSize(ctx)
        val longSide = maxOf(rw, rh)
        val shortSide = minOf(rw, rh)
        // Width/height as the phone should render for the chosen orientation.
        val (w, h) = if (orientation == Orientation.PORTRAIT) shortSide to longSide else longSide to shortSide
        // Advertise a CAR-appropriate density, NOT the phone's physical dpi. A phone panel is
        // ~400-500dpi, which makes Android Auto draw phone-sized (huge) UI on a "car" screen.
        // Real head units report ~160dpi, so AA lays out car-sized elements; the video is then
        // scaled onto the physical panel. (Higher-res picks a slightly higher dpi for crispness.)
        val autoDpi = if (maxOf(w, h) >= 1900) CAR_DENSITY_DPI_HIGH else CAR_DENSITY_DPI
        val densityDpi = savedDensityDpi(ctx).let { if (it > 0) it else autoDpi }

        val res = if (orientation == Orientation.PORTRAIT) {
            if (w > 720 || h > 1280) ResType._1080x1920 else ResType._720x1280
        } else {
            when {
                w <= 800 && h <= 480 -> ResType._800x480
                w > 1280 || h > 720 -> ResType._1920x1080
                else -> ResType._1280x720
            }
        }
        val (vw, vh) = dimsOf(res)
        return VideoConfig(res, vw, vh, densityDpi, orientation)
    }

    /** Standard pixel dimensions for an AA resolution enum. */
    fun dimsOf(res: ResType): Pair<Int, Int> = when (res) {
        ResType._800x480 -> 800 to 480
        ResType._1280x720 -> 1280 to 720
        ResType._1920x1080 -> 1920 to 1080
        ResType._2560x1440 -> 2560 to 1440
        ResType._3840x2160 -> 3840 to 2160
        ResType._720x1280 -> 720 to 1280
        ResType._1080x1920 -> 1080 to 1920
        ResType._1440x2560 -> 1440 to 2560
        ResType._2160x3840 -> 2160 to 3840
        else -> 800 to 480
    }
}
