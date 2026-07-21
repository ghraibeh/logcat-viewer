package com.mobilelabkit.aahelper

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * A transparent, no-UI activity whose only job is to fire the Android Auto trigger from the
 * **foreground**.
 *
 * Why it exists: the keep-alive service fires the trigger from the background, and on Android 12+
 * (hard-enforced on 14+) a background/service context can't `startActivity` another app's
 * component — Background Activity Launch (BAL) silently drops it. So the trigger's reliable
 * "activity" path never landed when auto-started, which is a big part of "sometimes it works".
 *
 * The service starts THIS activity instead (allowed: it's our own component, and we hold a
 * foreground service). Once we're the resumed, foreground activity, launching gearhead's
 * `WirelessStartupActivity` is a foreground→foreground start, which BAL permits. If that still
 * fails on a given AA build, we fall back to the broadcast trigger. Then we finish immediately.
 */
class TransparentTriggerActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setBackgroundDrawableResource(android.R.color.transparent)

        val target: Intent? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                intent.getParcelableExtra(EXTRA_INTENT, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_INTENT)

        if (target == null) { finish(); return }

        try {
            startActivity(target)
            Log.i(TAG, "fired AA WirelessStartupActivity from foreground")
        } catch (e: Exception) {
            Log.w(TAG, "activity trigger failed (${e.message}); trying broadcast")
            runCatching {
                val port = target.getIntExtra("PARAM_SERVICE_PORT", target.getIntExtra("projection_port", 5288))
                val host = target.getStringExtra("PARAM_HOST_ADDRESS") ?: "127.0.0.1"
                sendBroadcast(Intent().apply {
                    setClassName(AaTrigger.GEARHEAD, "${AaTrigger.WIRELESS}.setup.receiver.WirelessStartupReceiver")
                    action = "${AaTrigger.WIRELESS}.setup.receiver.wirelessstartup.START"
                    putExtra("ip_address", host)
                    putExtra("projection_port", port)
                    addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
                })
            }.onFailure { Log.e(TAG, "broadcast trigger also failed: ${it.message}") }
        }
        // No animation needed — the launcher sets FLAG_ACTIVITY_NO_ANIMATION and we're translucent.
        finish()
    }

    companion object {
        private const val TAG = "aahelper-trigger"
        const val EXTRA_INTENT = "intent"
    }
}
