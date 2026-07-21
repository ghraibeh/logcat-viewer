package com.mobilelabkit.headunit

import android.animation.Animator
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.LinearInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/**
 * The head unit's idle / connecting screen — a designed, product-quality surface. Deliberately
 * MINIMAL: brand top-bar, a "you can connect by" method list (USB / Wireless / AP WIFI — tap one
 * to preview it), and a connect area that shows whichever method is selected: the scan-to-connect
 * QR (AP WIFI — SoftAP or shared-network, see [setSoftAp]/[setShareIp]), an animated USB cable
 * (USB), or an animated broadcasting router (Wireless). A live status line surfaces only while
 * connecting / on error. Hidden while video streams.
 *
 * Structure lives in [R.layout.view_idle_portrait] / [R.layout.view_idle_landscape] — inflated
 * (not built programmatically) so the visual design is real XML/drawable resources. This class
 * only holds the runtime behavior an XML layout can't express: which of the two variants is
 * showing (decided from the ACTUAL measured pixel size in [onSizeChanged], since the panel's real
 * density is far higher than the AA "car" density we advertise — a configuration-qualifier-based
 * layout-land/ split would pick the wrong one), the QR bitmap/size, the selected method tab +
 * its animations, and state-driven visibility.
 */
class IdleView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : FrameLayout(context, attrs, defStyleAttr) {

    enum class Phase { WAITING, CONNECTING, CONNECTED, ERROR }
    enum class Method { USB, WIRELESS, AP_WIFI }

    var onSettings: (() -> Unit)? = null
    /** Fired when the USER taps a method card — the host turns the SoftAP on (AP_WIFI) or off
     *  (USB/WIRELESS) in response. NOT fired by [setActiveMethod] (programmatic sync). */
    var onMethodSelected: ((Method) -> Unit)? = null

    private lateinit var stateText: TextView
    private lateinit var stateRow: LinearLayout
    private lateinit var stateProgress: ProgressBar
    private lateinit var stateCheck: ImageView
    private lateinit var chipUsb: View
    private lateinit var chipWireless: View
    private lateinit var chipApWifi: View
    private lateinit var connectPanel: View
    private lateinit var wirelessHint: View
    private lateinit var hintText: TextView
    private lateinit var qrImage: ImageView
    private lateinit var usbAnimArea: View
    private lateinit var cableTrack: View
    private lateinit var usbDot: View
    private lateinit var wirelessAnimArea: View
    private lateinit var ring1: View
    private lateinit var ring2: View
    private lateinit var ring3: View

    private var stPhase = Phase.WAITING
    private var stMethod = Method.AP_WIFI
    private var stDetail: String? = ""
    private var stSoftAp: SoftApHost.Info? = null
    private var stShareIp: String? = null
    private var stUsb = true
    private var stWireless = false
    private var stDisplay = ""

    private var qrShownFor: String? = null
    private var qrPx = 0
    private var built = false
    private var builtLandscape: Boolean? = null

    private var usbAnimator: Animator? = null
    private var ringAnimators: List<Animator> = emptyList()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w == 0 || h == 0) return
        val landscape = w >= h
        // Size the QR (raw px, density-independent) so the layout always fits with margin — no clip,
        // no scroll. Landscape is height-constrained; portrait has height to spare so it's off width.
        qrPx = if (landscape) (h * 0.42f).toInt().coerceIn(300, 460)
        else (w * 0.52f).toInt().coerceIn(280, 520)
        if (builtLandscape != landscape) {
            builtLandscape = landscape
            qrShownFor = null
            build(landscape)
            built = true
            applyAll()
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        stopUsbAnimation(); stopWirelessAnimation()
    }

    /** Nothing in this screen ever calls requestFocus() on its own, so a TV remote's D-pad has
     *  nothing to move focus from/to whenever the idle screen (re)appears — e.g. after a session
     *  disconnects and we're back to "waiting for a phone". Seed focus each time. */
    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (changedView === this && visibility == View.VISIBLE && built) requestInitialFocus()
    }

    private fun requestInitialFocus() {
        val target = when (stMethod) {
            Method.USB -> chipUsb
            Method.WIRELESS -> chipWireless
            Method.AP_WIFI -> chipApWifi
        }
        (if (target.visibility == View.VISIBLE) target else findViewById(R.id.btnSettings)).requestFocus()
    }

    // --- construction ------------------------------------------------------------
    private fun build(landscape: Boolean) {
        if (built) { stopUsbAnimation(); stopWirelessAnimation() }
        removeAllViews()
        val res = if (landscape) R.layout.view_idle_landscape else R.layout.view_idle_portrait
        LayoutInflater.from(context).inflate(res, this, true)

        findViewById<View>(R.id.btnSettings).setOnClickListener { onSettings?.invoke() }
        chipUsb = findViewById(R.id.chipUsb)
        chipWireless = findViewById(R.id.chipWireless)
        chipApWifi = findViewById(R.id.chipApWifi)
        chipUsb.setOnClickListener { selectMethod(Method.USB) }
        chipWireless.setOnClickListener { selectMethod(Method.WIRELESS) }
        chipApWifi.setOnClickListener { selectMethod(Method.AP_WIFI) }
        stateRow = findViewById(R.id.stateRow)
        stateProgress = findViewById(R.id.stateProgress)
        stateCheck = findViewById(R.id.stateCheck)
        stateText = findViewById(R.id.stateText)
        connectPanel = findViewById(R.id.connectPanel)
        wirelessHint = findViewById(R.id.wirelessHint)
        hintText = findViewById(R.id.hintText)
        qrImage = findViewById(R.id.qrImage)
        usbAnimArea = findViewById(R.id.usbAnimArea)
        cableTrack = findViewById(R.id.cableTrack)
        usbDot = findViewById(R.id.usbDot)
        wirelessAnimArea = findViewById(R.id.wirelessAnimArea)
        ring1 = findViewById(R.id.ring1)
        ring2 = findViewById(R.id.ring2)
        ring3 = findViewById(R.id.ring3)
        qrImage.layoutParams = qrImage.layoutParams.apply {
            width = if (qrPx > 0) qrPx else width; height = if (qrPx > 0) qrPx else height
        }
    }

    // --- public API ------------------------------------------------------------
    /** Kept for the caller; display info is intentionally not shown on the idle screen. */
    fun setDisplayLabel(text: String) { stDisplay = text }

    fun setMethods(usb: Boolean, wireless: Boolean) {
        stUsb = usb; stWireless = wireless
        if (built) { chipUsb.visibility = vis(usb); chipWireless.visibility = vis(wireless) }
    }

    fun setSoftAp(info: SoftApHost.Info?) { stSoftAp = info; if (built) applyConnect() }

    /** This device's LAN IP when reachable on a shared Wi-Fi (no SoftAP) — lets the AP WIFI tab
     *  show a scan-to-connect QR even outside Host-Wi-Fi mode. Null while not yet known/reachable. */
    fun setShareIp(ip: String?) { stShareIp = ip; if (built) applyConnect() }

    fun showState(phase: Phase, detail: String?) {
        stPhase = phase; if (detail != null) stDetail = detail
        if (built) { applyState(); applyConnect() }
    }

    private fun applyAll() {
        applyState(); updateChipSelection(); applyConnect()
        chipUsb.visibility = vis(stUsb); chipWireless.visibility = vis(stWireless)
        if (visibility == View.VISIBLE) requestInitialFocus()
    }

    /** Tapping a method chip selects it (USB/Wireless/AP WIFI are mutually exclusive) AND tells the
     *  host to (dis)engage that transport — AP WIFI starts the SoftAP + shows its join QR, USB and
     *  Wireless stop it. */
    private fun selectMethod(m: Method) {
        if (stMethod == m) return
        stMethod = m
        updateChipSelection()
        applyConnect()
        onMethodSelected?.invoke(m)
    }

    /** Highlight [m] WITHOUT firing [onMethodSelected] — used to sync the tab to the persisted mode
     *  (initial load, or a change made from the Settings sheet). */
    fun setActiveMethod(m: Method) {
        stMethod = m
        if (built) { updateChipSelection(); applyConnect() }
    }

    private fun updateChipSelection() {
        chipUsb.setBackgroundResource(if (stMethod == Method.USB) R.drawable.bg_method_chip_selected else R.drawable.bg_method_chip)
        chipWireless.setBackgroundResource(if (stMethod == Method.WIRELESS) R.drawable.bg_method_chip_selected else R.drawable.bg_method_chip)
        chipApWifi.setBackgroundResource(if (stMethod == Method.AP_WIFI) R.drawable.bg_method_chip_selected else R.drawable.bg_method_chip)
    }

    /** The connect area shows exactly one of: the QR (AP WIFI), the USB cable animation, the
     *  Wireless router animation — or, once a phone has actually triggered a connection attempt
     *  (CONNECTING), the generic "Connecting…" card, overriding whichever tab is selected. */
    private fun applyConnect() {
        if (stPhase == Phase.CONNECTING) {
            connectPanel.visibility = View.GONE
            usbAnimArea.visibility = View.GONE
            wirelessAnimArea.visibility = View.GONE
            wirelessHint.visibility = View.VISIBLE
            stopUsbAnimation(); stopWirelessAnimation()
            hintText.text = "Connecting…"
            return
        }

        val ip = stSoftAp?.ip ?: stShareIp
        val showQr = stMethod == Method.AP_WIFI && ip != null
        val showFallbackHint = stMethod == Method.AP_WIFI && ip == null

        connectPanel.visibility = vis(showQr)
        usbAnimArea.visibility = vis(stMethod == Method.USB)
        wirelessAnimArea.visibility = vis(stMethod == Method.WIRELESS)
        wirelessHint.visibility = vis(showFallbackHint)

        if (stMethod == Method.USB) startUsbAnimation() else stopUsbAnimation()
        if (stMethod == Method.WIRELESS) startWirelessAnimation() else stopWirelessAnimation()

        if (showQr) {
            val uri = QrGen.joinUri(stSoftAp?.ssid, stSoftAp?.passphrase, ip!!, 5288)
            if (uri != qrShownFor && qrPx > 0) {
                QrGen.bitmap(uri, qrPx)?.let { bmp: Bitmap -> qrImage.setImageBitmap(bmp); qrShownFor = uri }
            }
        } else {
            qrShownFor = null
        }
        if (showFallbackHint) hintText.text = "Waiting for a phone"
    }

    private fun applyState() {
        // The idle screen carries no state chip; a short line surfaces only when there's something
        // transient to say (connecting / connected / error).
        val detail = stDetail?.takeIf { it.isNotBlank() && stPhase != Phase.WAITING }
        stateText.text = detail ?: ""
        stateText.setTextColor(resources.getColor(if (stPhase == Phase.ERROR) R.color.hu_red else R.color.hu_text_sec, null))
        stateRow.visibility = vis(detail != null)
        stateProgress.visibility = vis(stPhase == Phase.CONNECTING)
        stateCheck.visibility = vis(stPhase == Phase.CONNECTED)
    }

    // --- tab animations ----------------------------------------------------------
    /** A dot slides back and forth along the cable track between the two device boxes, suggesting
     *  a live USB connection. Waits for the track to be measured (post) since its width isn't
     *  known until the first layout pass. */
    private fun startUsbAnimation() {
        if (usbAnimator != null) return
        val track = cableTrack; val dot = usbDot
        fun launch() {
            val range = (track.width - dot.width).coerceAtLeast(0).toFloat()
            if (range <= 0f) { track.post { if (usbAnimArea.visibility == View.VISIBLE) launch() }; return }
            usbAnimator = ObjectAnimator.ofFloat(dot, View.TRANSLATION_X, 0f, range).apply {
                duration = 900
                repeatMode = ValueAnimator.REVERSE
                repeatCount = ValueAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
                start()
            }
        }
        if (track.width > 0) launch() else track.post { launch() }
    }

    private fun stopUsbAnimation() {
        usbAnimator?.cancel(); usbAnimator = null
        usbDot.translationX = 0f
    }

    /** Three concentric rings pulse outward from the router badge in a staggered loop, like a
     *  broadcasting Wi-Fi signal. */
    private fun startWirelessAnimation() {
        if (ringAnimators.isNotEmpty()) return
        ringAnimators = listOf(ring1 to 0L, ring2 to 600L, ring3 to 1200L).map { (ring, delay) ->
            ring.scaleX = 1f; ring.scaleY = 1f; ring.alpha = 0.9f
            val sx = ObjectAnimator.ofFloat(ring, View.SCALE_X, 1f, 2.2f).apply {
                repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.RESTART
            }
            val sy = ObjectAnimator.ofFloat(ring, View.SCALE_Y, 1f, 2.2f).apply {
                repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.RESTART
            }
            val a = ObjectAnimator.ofFloat(ring, View.ALPHA, 0.9f, 0f).apply {
                repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.RESTART
            }
            AnimatorSet().apply {
                playTogether(sx, sy, a)
                duration = 1800
                startDelay = delay
                interpolator = LinearInterpolator()
                start()
            }
        }
    }

    private fun stopWirelessAnimation() {
        ringAnimators.forEach { it.cancel() }
        ringAnimators = emptyList()
        for (ring in listOf(ring1, ring2, ring3)) if (::ring1.isInitialized) {
            ring.scaleX = 1f; ring.scaleY = 1f; ring.alpha = 0.9f
        }
    }

    private fun vis(on: Boolean) = if (on) View.VISIBLE else View.GONE
}
