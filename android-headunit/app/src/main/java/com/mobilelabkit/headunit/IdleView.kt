package com.mobilelabkit.headunit

import android.content.Context
import android.graphics.Bitmap
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/**
 * The head unit's idle / connecting screen — a designed, product-quality surface. Deliberately
 * MINIMAL: brand top-bar, a "you can connect by" hint with two method chips (info only), and a
 * scan-to-connect QR sitting on the background (SoftAP or shared-network — see [setSoftAp]/
 * [setShareIp]). A live status line surfaces only while connecting / on error. Hidden while video
 * streams.
 *
 * Structure lives in [R.layout.view_idle_portrait] / [R.layout.view_idle_landscape] — inflated
 * (not built programmatically) so the visual design is real XML/drawable resources. This class
 * only holds the runtime behavior an XML layout can't express: which of the two variants is
 * showing (decided from the ACTUAL measured pixel size in [onSizeChanged], since the panel's real
 * density is far higher than the AA "car" density we advertise — a configuration-qualifier-based
 * layout-land/ split would pick the wrong one), the QR bitmap/size, and state-driven visibility.
 */
class IdleView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : FrameLayout(context, attrs, defStyleAttr) {

    enum class Phase { WAITING, CONNECTING, CONNECTED, ERROR }

    var onSettings: (() -> Unit)? = null

    private lateinit var stateText: TextView
    private lateinit var stateRow: LinearLayout
    private lateinit var stateProgress: ProgressBar
    private lateinit var stateCheck: ImageView
    private lateinit var chipUsb: View
    private lateinit var chipWireless: View
    private lateinit var connectPanel: View
    private lateinit var wirelessHint: View
    private lateinit var hintText: TextView
    private lateinit var qrImage: ImageView

    private var stPhase = Phase.WAITING
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

    // --- construction ------------------------------------------------------------
    private fun build(landscape: Boolean) {
        removeAllViews()
        val res = if (landscape) R.layout.view_idle_landscape else R.layout.view_idle_portrait
        LayoutInflater.from(context).inflate(res, this, true)

        findViewById<View>(R.id.btnSettings).setOnClickListener { onSettings?.invoke() }
        chipUsb = findViewById(R.id.chipUsb)
        chipWireless = findViewById(R.id.chipWireless)
        stateRow = findViewById(R.id.stateRow)
        stateProgress = findViewById(R.id.stateProgress)
        stateCheck = findViewById(R.id.stateCheck)
        stateText = findViewById(R.id.stateText)
        connectPanel = findViewById(R.id.connectPanel)
        wirelessHint = findViewById(R.id.wirelessHint)
        hintText = findViewById(R.id.hintText)
        qrImage = findViewById(R.id.qrImage)
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

    /** This device's LAN IP when reachable on a shared Wi-Fi (no SoftAP) — lets the idle screen
     *  show a scan-to-connect QR even outside Host-Wi-Fi mode. Null while not yet known/reachable. */
    fun setShareIp(ip: String?) { stShareIp = ip; if (built) applyConnect() }

    fun showState(phase: Phase, detail: String?) {
        stPhase = phase; if (detail != null) stDetail = detail
        if (built) { applyState(); applyConnect() }
    }

    private fun applyAll() {
        applyState(); applyConnect()
        chipUsb.visibility = vis(stUsb); chipWireless.visibility = vis(stWireless)
    }

    /** The default idle state is the QR — scan-to-connect, no waiting. The generic "Waiting for a
     *  phone" card only takes over once a phone has actually triggered a connection attempt
     *  (CONNECTING), or as a fallback while we have no join info to encode yet (e.g. IP not resolved). */
    private fun applyConnect() {
        val soft = stSoftAp
        val ip = soft?.ip ?: stShareIp
        val showQr = ip != null && stPhase != Phase.CONNECTING
        connectPanel.visibility = vis(showQr)
        wirelessHint.visibility = vis(!showQr)
        if (showQr) {
            val uri = QrGen.joinUri(soft?.ssid, soft?.passphrase, ip!!, 5288)
            if (uri != qrShownFor && qrPx > 0) {
                QrGen.bitmap(uri, qrPx)?.let { bmp: Bitmap -> qrImage.setImageBitmap(bmp); qrShownFor = uri }
            }
        } else {
            qrShownFor = null
            hintText.text = if (ip != null) "Connecting…" else "Waiting for a phone"
        }
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

    private fun vis(on: Boolean) = if (on) View.VISIBLE else View.GONE
}
