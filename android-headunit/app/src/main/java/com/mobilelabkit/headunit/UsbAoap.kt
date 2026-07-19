package com.mobilelabkit.headunit

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.util.Log

/**
 * USB / AOAP (Android Open Accessory Protocol) transport for the Android Auto head unit.
 *
 * We are the USB **host**. A phone plugged in first appears as an ordinary USB device;
 * we send the AOAP control sequence — getProtocol → six identity strings (the pair
 * manufacturer="Android", model="Android Auto" is what tells the phone to start Android
 * Auto) → start — after which the phone **re-enumerates** as an AOAP accessory
 * (VID 0x18D1, PID 0x2D00, or 0x2D01 when ADB is on). We then claim its bulk IN/OUT
 * endpoints; every Android Auto protocol frame flows over those.
 *
 * Constants + string values mirror aasdk's USB/AccessoryMode* (the reverse-engineered
 * reference). Phase 1 stops once the bulk link is open; framing/TLS/channels are Phase 2+.
 */
object UsbAoap {
    private const val TAG = "headunit-usb"

    // AOAP vendor control requests (bmRequest).
    private const val ACC_REQ_GET_PROTOCOL = 51
    private const val ACC_REQ_SEND_STRING = 52
    private const val ACC_REQ_START = 53

    // bmRequestType: vendor requests, host→device (OUT) or device→host (IN).
    private const val USB_TYPE_VENDOR = 0x40
    private const val REQ_OUT = UsbConstants.USB_DIR_OUT or USB_TYPE_VENDOR // 0x40
    private const val REQ_IN = UsbConstants.USB_DIR_IN or USB_TYPE_VENDOR   // 0xC0

    // AOAP send-string indices (enum order in aasdk).
    private const val STR_MANUFACTURER = 0
    private const val STR_MODEL = 1
    private const val STR_DESCRIPTION = 2
    private const val STR_VERSION = 3
    private const val STR_URI = 4
    private const val STR_SERIAL = 5

    // Google's AOAP accessory identity after re-enumeration.
    const val AOAP_VID = 0x18D1
    private val AOAP_PIDS = intArrayOf(0x2D00, 0x2D01, 0x2D02, 0x2D03, 0x2D04, 0x2D05)

    /** True once the device is in AOAP accessory mode (post-START, re-enumerated). */
    fun isAccessory(device: UsbDevice): Boolean =
        device.vendorId == AOAP_VID && AOAP_PIDS.contains(device.productId)

    /** An open bulk link to a phone in AOAP mode. Read/write full AA frames here. */
    class Link(
        private val conn: UsbDeviceConnection,
        private val iface: UsbInterface,
        private val epIn: UsbEndpoint,
        private val epOut: UsbEndpoint
    ) {
        fun write(data: ByteArray, offset: Int = 0, len: Int = data.size, timeoutMs: Int = 3000): Int =
            conn.bulkTransfer(epOut, if (offset == 0) data else data.copyOfRange(offset, offset + len), len, timeoutMs)

        fun read(buf: ByteArray, timeoutMs: Int): Int =
            conn.bulkTransfer(epIn, buf, buf.size, timeoutMs)

        val maxPacketIn: Int get() = epIn.maxPacketSize

        fun close() {
            runCatching { conn.releaseInterface(iface) }
            runCatching { conn.close() }
        }
    }

    /**
     * Send the AOAP accessory-start sequence to a freshly-attached (non-accessory) phone.
     * On success the phone drops off USB and re-attaches as an AOAP accessory (caught by
     * the activity's USB_DEVICE_ATTACHED handler). Returns false if the phone doesn't
     * speak AOAP (protocol 0) or a control transfer fails.
     */
    fun startAccessoryMode(conn: UsbDeviceConnection): Boolean {
        val proto = ByteArray(2)
        val n = conn.controlTransfer(REQ_IN, ACC_REQ_GET_PROTOCOL, 0, 0, proto, proto.size, 3000)
        if (n < 2) {
            Log.w(TAG, "getProtocol failed ($n)")
            return false
        }
        val version = (proto[0].toInt() and 0xff) or ((proto[1].toInt() and 0xff) shl 8)
        Log.i(TAG, "AOAP protocol version = $version")
        if (version < 1) {
            Log.w(TAG, "device does not support AOAP")
            return false
        }

        val ok = sendString(conn, STR_MANUFACTURER, "Android") &&
            sendString(conn, STR_MODEL, "Android Auto") &&
            sendString(conn, STR_DESCRIPTION, "Android Auto") &&
            sendString(conn, STR_VERSION, "2.0.1") &&
            sendString(conn, STR_URI, "https://mobilelabkit.local") &&
            sendString(conn, STR_SERIAL, "HU-MLK000001")
        if (!ok) return false

        val started = conn.controlTransfer(REQ_OUT, ACC_REQ_START, 0, 0, null, 0, 3000)
        Log.i(TAG, "ACC_REQ_START -> $started (device will re-enumerate)")
        return started >= 0
    }

    private fun sendString(conn: UsbDeviceConnection, index: Int, value: String): Boolean {
        val bytes = (value.toByteArray(Charsets.US_ASCII)) + 0 // NUL-terminated
        val r = conn.controlTransfer(REQ_OUT, ACC_REQ_SEND_STRING, 0, index, bytes, bytes.size, 3000)
        if (r < 0) Log.w(TAG, "sendString[$index]=\"$value\" failed ($r)")
        return r >= 0
    }

    /**
     * Open the bulk IN/OUT link on a phone that is already in AOAP accessory mode.
     * Picks the first interface exposing a bulk IN + bulk OUT pair (interface 0 for
     * plain accessory; the ADB interface is skipped by looking for the AA bulk pair).
     */
    fun openLink(mgr: UsbManager, device: UsbDevice): Link? {
        val conn = mgr.openDevice(device) ?: run {
            Log.w(TAG, "openDevice failed (no permission?)")
            return null
        }
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            var epIn: UsbEndpoint? = null
            var epOut: UsbEndpoint? = null
            for (e in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(e)
                if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                if (ep.direction == UsbConstants.USB_DIR_IN) epIn = ep else epOut = ep
            }
            if (epIn != null && epOut != null) {
                if (!conn.claimInterface(iface, true)) {
                    Log.w(TAG, "claimInterface($i) failed")
                    continue
                }
                Log.i(TAG, "AOAP bulk link open on interface $i (in=${epIn.address}, out=${epOut.address})")
                return Link(conn, iface, epIn, epOut)
            }
        }
        Log.w(TAG, "no bulk IN/OUT interface found")
        conn.close()
        return null
    }
}
