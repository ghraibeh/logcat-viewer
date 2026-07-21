package com.mobilelabkit.headunit

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.net.URLEncoder

/**
 * Builds the join QR shown on the head-unit's idle screen. The phone-side helper scans it and
 * connects — in Host-Wi-Fi mode it also joins the SoftAP first, so the auto-generated
 * (per-restart-changing) password never has to be typed.
 *
 * Payload is a compact URI the helper parses: `mlkhu://join?ip=..&port=..[&ssid=..&pass=..]`.
 * `ssid` is present only for a Host-Wi-Fi (SoftAP) join; on a shared network the head unit is
 * already reachable, so the code is just its ip:port.
 */
object QrGen {

    fun joinUri(ssid: String?, pass: String?, ip: String, port: Int): String {
        fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        val sb = StringBuilder("mlkhu://join?ip=").append(enc(ip)).append("&port=").append(port)
        if (!ssid.isNullOrEmpty()) {
            sb.append("&ssid=").append(enc(ssid))
            if (!pass.isNullOrEmpty()) sb.append("&pass=").append(enc(pass))
        }
        return sb.toString()
    }

    /** Render [text] to a square QR [Bitmap] of [size] px, or null on failure. */
    fun bitmap(text: String, size: Int): Bitmap? = runCatching {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 1
        )
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        for (x in 0 until size) for (y in 0 until size) {
            bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
        }
        bmp
    }.getOrNull()
}
