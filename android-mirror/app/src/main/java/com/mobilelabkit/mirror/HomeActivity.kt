package com.mobilelabkit.mirror

import android.app.Activity
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Role picker. This one app is both ends of the mirror: run "Cast this screen" on the
 * source and "Receive a screen" on the target (Android or the iOS twin — same MLK1
 * protocol). Owning both ends is what lets us skip the native cast picker (and its
 * Chromecast/Miracast gatekeeping) entirely — discovery + transport are our own.
 *
 * Visual design mirrors the iOS app's home screen: hero glyph + title + subtitle, then
 * role CARDS (icon circle, title/subtitle column, chevron) instead of flat buttons. Still
 * 100% code-built views, and every card keeps the TV D-pad focus ring ([tvFocusable]).
 */
class HomeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            allowFocusOverflow() // let the D-pad focus ring draw past the cards' edges
        }

        // Hero glyph: two overlapping rounded rectangles, the iOS app's motif.
        root.addView(MirrorGlyphView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(64), dp(56)).apply {
                gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(14)
            }
        })
        root.addView(TextView(this).apply {
            text = "MLK Mirror"
            setTextColor(Color.WHITE); textSize = 32f
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(8))
        })
        root.addView(TextView(this).apply {
            text = "Screen + audio mirroring between Android and iOS\non your own network — no cast infrastructure."
            setTextColor(SUBTLE); textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(36))
        })

        // iOS card order: Receive first, Cast second.
        val receiveCard = roleCard(
            glyph = "↓", title = "Receive a screen", subtitle = "Show another device here"
        ) { startActivity(Intent(this, ReceiverActivity::class.java)) }
        val castCard = roleCard(
            glyph = "↑", title = "Cast this screen", subtitle = "Stream this phone to a receiver"
        ) { startActivity(Intent(this, SenderActivity::class.java)) }
        root.addView(receiveCard)
        root.addView(castCard)

        setContentView(root)

        // Deterministic D-pad starting point: on a TV the common role is receiver (cast a
        // phone *to* the TV); on a phone, casting. `focusedByDefault` (API 26+) is resolved
        // by the framework when the window gains focus — unlike a posted requestFocus(), it
        // doesn't race the framework's own initial-focus pick.
        val initialFocus = if (TvUi.isTelevision(this)) receiveCard else castCard
        initialFocus.isFocusedByDefault = true
        initialFocus.post { initialFocus.requestFocus() } // belt-and-suspenders after layout
    }

    /** One iOS-style role card: cyan icon circle · title over subtitle · chevron. */
    private fun roleCard(glyph: String, title: String, subtitle: String, onClick: () -> Unit): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(14) }
            tvFocusable(CARD_BG) // card fill + a visible D-pad focus ring
            isClickable = true
            setOnClickListener { onClick() }
        }

        card.addView(TextView(this).apply {
            text = glyph
            setTextColor(Color.WHITE); textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(CYAN) }
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40)).apply { rightMargin = dp(14) }
        })

        card.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            addView(TextView(this@HomeActivity).apply {
                text = title
                setTextColor(Color.WHITE); textSize = 17f
                setTypeface(typeface, Typeface.BOLD)
            })
            addView(TextView(this@HomeActivity).apply {
                text = subtitle
                setTextColor(SUBTLE); textSize = 12f
                setPadding(0, dp(2), 0, 0)
            })
        })

        card.addView(TextView(this).apply {
            text = "›"
            setTextColor(Color.parseColor("#5A6572")); textSize = 24f
            setPadding(dp(8), 0, 0, dp(4))
        })

        return card
    }

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    private companion object {
        val CYAN = Color.parseColor("#32ADE6")     // iOS systemCyan
        val CARD_BG = Color.parseColor("#1C1C1E")  // iOS secondarySystemBackground (dark)
        val SUBTLE = Color.parseColor("#9FB0C0")
    }
}

/** The iOS app's hero motif — two overlapping rounded-rect outlines — drawn, no assets. */
private class MirrorGlyphView(ctx: Activity) : View(ctx) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#32ADE6")
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        paint.strokeWidth = w * 0.055f
        val r = w * 0.12f
        val inset = paint.strokeWidth / 2
        // Back rectangle (top-left), front rectangle (bottom-right) — like ⧉.
        canvas.drawRoundRect(RectF(inset, inset, w * 0.70f, h * 0.70f), r, r, paint)
        canvas.drawRoundRect(RectF(w * 0.30f, h * 0.30f, w - inset, h - inset), r, r, paint)
    }
}
