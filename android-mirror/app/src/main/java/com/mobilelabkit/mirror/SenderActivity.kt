package com.mobilelabkit.mirror

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * Sender role: browse for `_mlkmirror._tcp` receivers on the Wi-Fi, let the user pick one,
 * ask for screen-capture consent, then hand the capture token + target to
 * [ScreenCaptureService] which does the actual encode/stream. The UI is built in code (no
 * XML) to stay dependency-light, matching the sibling apps.
 */
class SenderActivity : Activity() {

    private val browser by lazy { MirrorDiscovery.Browser(applicationContext) }
    private var receivers: List<MirrorDiscovery.Receiver> = emptyList()
    private var selected: MirrorDiscovery.Receiver? = null
    private var casting = false
    private var muteWhileCasting = true

    private lateinit var listContainer: LinearLayout
    private lateinit var emptyLabel: TextView
    private var a11yCheck: CheckBox? = null
    private var suppressA11yListener = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Ask up-front for notifications (FGS notice) and mic (playback-audio capture). Both
        // are optional — casting still works video-only if either is denied.
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) add(Manifest.permission.POST_NOTIFICATIONS)
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                add(Manifest.permission.RECORD_AUDIO)
        }
        if (wanted.isNotEmpty()) requestPermissions(wanted.toTypedArray(), REQ_PERMS)
        showListUi()
    }

    override fun onResume() {
        super.onResume()
        if (!casting) startBrowsing()
        syncA11yCheck() // reflect real state after returning from accessibility settings
    }

    // --- touch-control (accessibility) option ------------------------------------------
    private fun accessibilityComponent() = "$packageName/$packageName.MirrorAccessibilityService"

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(
            contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ).orEmpty()
        val target = accessibilityComponent()
        return enabled.split(':').any { it.equals(target, ignoreCase = true) }
    }

    /** Push the checkbox to the REAL OS state without firing the user listener. Android won't
     *  let an app flip an accessibility service itself, so the box mirrors Settings. */
    private fun syncA11yCheck() {
        val c = a11yCheck ?: return
        suppressA11yListener = true
        c.isChecked = isAccessibilityEnabled()
        suppressA11yListener = false
    }

    override fun onPause() {
        super.onPause()
        browser.stop()
    }

    // --- list screen -------------------------------------------------------------------
    private fun showListUi() {
        casting = false
        val root = column().apply { setPadding(dp(24), dp(48), dp(24), dp(24)) }
        root.addView(title("Cast this screen"))
        root.addView(subtitle(
            "Pick a receiver on your Wi-Fi.\n" +
                "On the other phone, open MobileLabKit Mirror ▸ Receive a screen."
        ))

        val muteToggle = CheckBox(this).apply {
            text = "Mute this phone while casting (audio only on receiver)"
            isAllCaps = false
            setTextColor(Color.parseColor("#C7D3DE"))
            textSize = 14f
            isChecked = muteWhileCasting
            buttonTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#1E88E5"))
            setPadding(dp(12), dp(16), dp(12), dp(12))
            tvFocusable(Color.TRANSPARENT) // focus ring only — no solid fill behind the checkbox
            setOnCheckedChangeListener { _, checked -> muteWhileCasting = checked }
        }
        root.addView(muteToggle)

        a11yCheck = CheckBox(this).apply {
            text = "Enable touch control (let the receiver tap this phone)"
            isAllCaps = false
            setTextColor(Color.parseColor("#C7D3DE"))
            textSize = 14f
            buttonTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#1E88E5"))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            tvFocusable(Color.TRANSPARENT)
            setOnCheckedChangeListener { _, wantOn ->
                if (suppressA11yListener) return@setOnCheckedChangeListener
                // We can't flip the OS accessibility toggle ourselves — send the user to the
                // one switch in Settings. onResume re-syncs the box to the real state.
                if (wantOn != isAccessibilityEnabled()) {
                    toast(if (wantOn) "Turn ON “MobileLabKit Mirror” to allow remote taps"
                          else "Turn OFF “MobileLabKit Mirror” to stop remote taps")
                    runCatching { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
                }
            }
        }
        root.addView(a11yCheck)
        syncA11yCheck()

        emptyLabel = subtitle("Searching for receivers…").apply { setPadding(0, dp(16), 0, 0) }
        listContainer = column()
        val scroll = ScrollView(this).apply {
            addView(listContainer)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }
        root.addView(emptyLabel)
        root.addView(scroll)
        setContentView(root)
        renderReceivers()
    }

    private fun startBrowsing() {
        browser.start { list ->
            runOnUiThread {
                receivers = list
                if (!casting) renderReceivers()
            }
        }
    }

    private fun renderReceivers() {
        if (!::listContainer.isInitialized) return
        listContainer.removeAllViews()
        emptyLabel.visibility = if (receivers.isEmpty()) View.VISIBLE else View.GONE
        for (r in receivers) {
            val b = Button(this).apply {
                text = r.name
                isAllCaps = false
                setTextColor(Color.WHITE)
                textSize = 17f
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setPadding(dp(20), dp(18), dp(20), dp(18))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(10) }
                tvFocusable(Color.parseColor("#1B2733")) // D-pad focus ring for the remote
                setOnClickListener { pick(r) }
            }
            listContainer.addView(b)
        }
        // Land the remote on the first receiver as soon as one appears, unless the user is already
        // navigating the options above.
        if (receivers.isNotEmpty() && listContainer.childCount > 0) {
            val focusInList = (0 until listContainer.childCount)
                .any { listContainer.getChildAt(it).hasFocus() }
            val optionsFocused = a11yCheck?.hasFocus() == true
            if (!focusInList && !optionsFocused) {
                val first = listContainer.getChildAt(0)
                first.post { first.requestFocus() } // after layout — see HomeActivity
            }
        }
    }

    private fun pick(r: MirrorDiscovery.Receiver) {
        selected = r
        val mpm = getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_PROJECTION)
    }

    @Deprecated("startActivityForResult is fine for this single, simple consent flow")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        val target = selected
        if (resultCode == RESULT_OK && data != null && target != null) {
            startCasting(resultCode, data, target)
        } else {
            toast("Screen capture cancelled")
        }
    }

    // --- casting screen ----------------------------------------------------------------
    private fun startCasting(resultCode: Int, data: Intent, target: MirrorDiscovery.Receiver) {
        val cap = computeCapture()
        val withAudio = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        ScreenCaptureService.onStopped = { err ->
            runOnUiThread {
                if (err != null) toast(err)
                showListUi()
                if (!casting) startBrowsing()
            }
        }
        val svc = Intent(this, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
            putExtra(ScreenCaptureService.EXTRA_HOST, target.host)
            putExtra(ScreenCaptureService.EXTRA_PORT, target.port)
            putExtra(ScreenCaptureService.EXTRA_WIDTH, cap.w)
            putExtra(ScreenCaptureService.EXTRA_HEIGHT, cap.h)
            putExtra(ScreenCaptureService.EXTRA_REAL_WIDTH, cap.realW)
            putExtra(ScreenCaptureService.EXTRA_REAL_HEIGHT, cap.realH)
            putExtra(ScreenCaptureService.EXTRA_DPI, cap.dpi)
            putExtra(ScreenCaptureService.EXTRA_BITRATE, cap.bitRate)
            putExtra(ScreenCaptureService.EXTRA_TARGET_NAME, target.name)
            putExtra(ScreenCaptureService.EXTRA_WITH_AUDIO, withAudio)
            putExtra(ScreenCaptureService.EXTRA_MUTE, muteWhileCasting)
        }
        startForegroundService(svc)
        browser.stop()
        showCastingUi(target.name)
    }

    private fun showCastingUi(name: String) {
        casting = true
        val root = column().apply {
            setPadding(dp(24), dp(48), dp(24), dp(24))
            gravity = Gravity.CENTER
        }
        root.addView(title("Casting…"))
        root.addView(subtitle("Mirroring your screen to\n$name"))
        val stop = Button(this).apply {
            text = "Stop casting"
            isAllCaps = false
            setTextColor(Color.WHITE)
            textSize = 18f
            setPadding(dp(24), dp(18), dp(24), dp(18))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(40) }
            tvFocusable(Color.parseColor("#7A1F1F"))
            setOnClickListener {
                ScreenCaptureService.stop(this@SenderActivity)
                showListUi()
                startBrowsing()
            }
        }
        stop.isFocusedByDefault = true // deterministic: remote lands on Stop while casting
        root.addView(stop)
        setContentView(root)
        stop.post { stop.requestFocus() }
    }

    override fun onDestroy() {
        super.onDestroy()
        browser.stop()
        ScreenCaptureService.onStopped = null
    }

    // --- capture sizing ----------------------------------------------------------------
    private data class Cap(
        val w: Int, val h: Int, val dpi: Int, val bitRate: Int,
        val realW: Int, val realH: Int,   // true display pixels — the dispatchGesture space
    )

    /** Real screen size, scaled so the long edge ≤ MAX_EDGE, dimensions rounded even. Uses the
     *  REAL display metrics (full physical resolution incl. system-bar areas) — that is exactly
     *  the coordinate space MediaProjection captures and AccessibilityService.dispatchGesture
     *  injects into, so touch mapping lands accurately. */
    private fun computeCapture(): Cap {
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION") windowManager.defaultDisplay.getRealMetrics(dm)
        val realW = dm.widthPixels
        val realH = dm.heightPixels
        val s = CaptureSpec.compute(realW, realH)
        return Cap(s.w, s.h, dm.densityDpi, s.bitRate, realW, realH)
    }

    // --- tiny view builders ------------------------------------------------------------
    private fun column() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(Color.BLACK)
        layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        )
        allowFocusOverflow() // D-pad focus rings can draw past child edges
    }

    private fun title(t: String) = TextView(this).apply {
        text = t; setTextColor(Color.WHITE); textSize = 26f
        setPadding(0, 0, 0, dp(12))
    }

    private fun subtitle(t: String) = TextView(this).apply {
        text = t; setTextColor(Color.parseColor("#9FB0C0")); textSize = 15f
    }

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_LONG).show()

    companion object {
        private const val REQ_PROJECTION = 1001
        private const val REQ_PERMS = 1002
    }
}
