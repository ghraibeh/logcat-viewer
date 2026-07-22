package com.mobilelabkit.mirror

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup

/**
 * TV / D-pad helpers. The UI is built in code with flat-colored `Button`/`CheckBox` views, which
 * show **no visible focus** on their own — a remote user can't tell what's selected. These give
 * every interactive view a bright focus ring + slight lift when it gains D-pad focus, and detect a
 * leanback (TV) device. Harmless on phones (touch focus never triggers the highlight).
 */
object TvUi {
    fun isTelevision(ctx: Context): Boolean {
        val ui = ctx.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        return ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }
}

/** The app's shared palette — the iOS twin's design language (systemCyan accents, dark
 *  secondary-background cards) so both platforms read as one product. */
object MirrorPalette {
    val CYAN = Color.parseColor("#32ADE6")      // iOS systemCyan
    val CARD_BG = Color.parseColor("#1C1C1E")   // iOS secondarySystemBackground (dark)
    val SUBTLE = Color.parseColor("#9FB0C0")    // secondary text
    val FAINT = Color.parseColor("#6C7686")     // tertiary text
    val CHEVRON = Color.parseColor("#5A6572")
    val RED = Color.parseColor("#FF453A")       // iOS systemRed (dark)
}

/**
 * Give [this] view a clear D-pad focus indicator (white ring + small scale-up), keeping [fillColor]
 * as its fill. Pass `Color.TRANSPARENT` for controls that shouldn't gain a solid background (e.g.
 * checkboxes) — they get just the ring.
 */
fun View.tvFocusable(fillColor: Int) {
    val radius = dpF(8f)
    val stroke = dpI(3)
    fun bg(focused: Boolean) = GradientDrawable().apply {
        cornerRadius = radius
        setColor(fillColor)
        setStroke(stroke, if (focused) Color.WHITE else Color.TRANSPARENT)
    }
    background = bg(false)
    isFocusable = true
    isFocusableInTouchMode = false
    setOnFocusChangeListener { v, hasFocus ->
        v.background = bg(hasFocus)
        val s = if (hasFocus) 1.04f else 1f
        v.animate().scaleX(s).scaleY(s).setDuration(120).start()
        v.z = if (hasFocus) dpF(8f) else 0f // lift above neighbours so the ring isn't overlapped
    }
}

/** Let a container's children draw their focus ring / scale slightly past their own bounds. */
fun ViewGroup.allowFocusOverflow() {
    clipChildren = false
    clipToPadding = false
}

private fun View.dpF(v: Float) =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

private fun View.dpI(v: Int) = dpF(v.toFloat()).toInt()
