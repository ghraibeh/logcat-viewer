package com.mobilelabkit.mirror

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Role picker. This one app is both ends of the Android→Android mirror: install it on both
 * phones, run "Cast this screen" on the source and "Receive a screen" on the target. Owning
 * both ends is what lets us skip the native cast picker (and its Chromecast/Miracast
 * gatekeeping) entirely — discovery + transport are our own.
 */
class HomeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.BLACK)
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        root.addView(TextView(this).apply {
            text = "MobileLabKit Mirror"
            setTextColor(Color.WHITE); textSize = 28f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(8))
        })
        root.addView(TextView(this).apply {
            text = "Screen mirroring between two Android phones on the same Wi-Fi."
            setTextColor(Color.parseColor("#9FB0C0")); textSize = 15f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(40))
        })

        root.addView(bigButton("Cast this screen", "#1E88E5") {
            startActivity(Intent(this, SenderActivity::class.java))
        })
        root.addView(bigButton("Receive a screen", "#2E7D32") {
            startActivity(Intent(this, ReceiverActivity::class.java))
        })

        setContentView(root)
    }

    private fun bigButton(label: String, color: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.parseColor(color))
        textSize = 19f
        setPadding(dp(24), dp(22), dp(24), dp(22))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(14) }
        setOnClickListener { onClick() }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()
}
