package com.mobilelabkit.headunit

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.util.Log
import com.andrerinas.headunitrevived.aap.protocol.proto.Wireless
import java.io.DataInputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Bluetooth bootstrap for **wireless Android Auto**. Listens on the AA Wireless RFCOMM UUID; when a
 * (paired) phone connects, it brings up a [WifiDirectHost] group and hands the phone its Wi-Fi
 * credentials + our TCP IP:5288 via the standard handshake. The phone then joins that Wi-Fi and
 * connects to [WirelessServer], where the normal AA protocol runs.
 *
 * RFCOMM framing: `[size:2 BE][type:2 BE][protobuf]`. Types: 1 = WifiStartRequest (HU→phone),
 * 2 = phone "ready" ack (phone→HU), 3 = WifiInfoResponse credentials (HU→phone).
 */
class BtBootstrap(
    private val context: Context,
    private val wifi: WifiDirectHost,
    private val onStatus: (String) -> Unit
) {
    @Volatile private var running = false
    private var serverSocket: BluetoothServerSocket? = null
    private var thread: Thread? = null

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: run { onStatus("No Bluetooth on this device."); return }
        if (!adapter.isEnabled) { onStatus("Turn on Bluetooth to use wireless AA."); return }
        running = true
        thread = Thread({ loop(adapter) }, "aap-bt-bootstrap").also { it.start() }
    }

    @SuppressLint("MissingPermission")
    private fun loop(adapter: BluetoothAdapter) {
        try {
            serverSocket = adapter.listenUsingRfcommWithServiceRecord("Android Auto", AA_UUID)
            onStatus("Wireless ready — pair this device + open Android Auto on the phone.")
            Log.i(TAG, "RFCOMM listening on $AA_UUID")
            while (running) {
                val socket = try {
                    serverSocket?.accept()
                } catch (e: Exception) {
                    if (running) Log.w(TAG, "accept: ${e.message}"); break
                } ?: break
                handle(socket)
            }
        } catch (e: Exception) {
            Log.e(TAG, "bt server error", e); onStatus("Wireless BT error: ${e.message}")
        } finally {
            runCatching { serverSocket?.close() }
        }
    }

    @SuppressLint("MissingPermission")
    private fun handle(socket: BluetoothSocket) {
        Log.i(TAG, "phone connected over BT: ${runCatching { socket.remoteDevice.address }.getOrNull()}")
        onStatus("Phone connected (Bluetooth) — bringing up Wi-Fi…")
        try {
            val input = DataInputStream(socket.inputStream)
            val output = socket.outputStream

            // Ensure a Wi-Fi Direct group exists; wait for its credentials (P2P can be slow).
            var creds = wifi.creds
            if (creds == null) {
                val latch = CountDownLatch(1)
                wifi.start { latch.countDown() }
                latch.await(30, TimeUnit.SECONDS)
                creds = wifi.creds
            }
            if (creds == null || creds.ssid.isEmpty()) {
                onStatus("Wi-Fi Direct failed — is Location (GPS) on?"); socket.close(); return
            }
            val c = creds

            Log.i(TAG, "TX WifiStartRequest ${c.ownerIp}:5288")
            send(output, 1, Wireless.WifiStartRequest.newBuilder()
                .setIpAddress(c.ownerIp).setPort(5288).setStatus(0).build().toByteArray())

            val (type, _) = read(input)
            Log.i(TAG, "RX type=$type")
            if (type == 2) {
                Thread.sleep(1000)
                Log.i(TAG, "TX WifiInfoResponse ssid=${c.ssid} bssid=${c.bssid}")
                send(output, 3, Wireless.WifiInfoResponse.newBuilder()
                    .setSsid(c.ssid).setKey(c.passphrase).setBssid(c.bssid)
                    .setSecurityMode(Wireless.SecurityMode.WPA2_PERSONAL)
                    .setAccessPointType(Wireless.AccessPointType.STATIC).build().toByteArray())
                onStatus("Wi-Fi credentials sent — phone joining + connecting…")
                while (running && socket.isConnected) Thread.sleep(3000)
            } else {
                onStatus("Phone declined wireless (type $type).")
            }
        } catch (e: Exception) {
            Log.e(TAG, "handshake error: ${e.message}", e)
        } finally {
            runCatching { socket.close() }
        }
    }

    private fun send(out: OutputStream, type: Int, data: ByteArray) {
        val buf = ByteBuffer.allocate(data.size + 4)
        buf.put((data.size shr 8).toByte()); buf.put((data.size and 0xFF).toByte())
        buf.putShort(type.toShort())
        buf.put(data)
        out.write(buf.array()); out.flush()
    }

    private fun read(input: DataInputStream): Pair<Int, ByteArray> {
        val header = ByteArray(4); input.readFully(header)
        val size = ((header[0].toInt() and 0xFF) shl 8) or (header[1].toInt() and 0xFF)
        val type = ((header[2].toInt() and 0xFF) shl 8) or (header[3].toInt() and 0xFF)
        val payload = if (size > 0) ByteArray(size).also { input.readFully(it) } else ByteArray(0)
        return type to payload
    }

    fun stop() {
        running = false
        runCatching { serverSocket?.close() }
        thread?.interrupt(); thread = null
    }

    companion object {
        private const val TAG = "headunit-bt"
        private val AA_UUID = UUID.fromString("4de17a00-52cb-11e6-bdf4-0800200c9a66")
    }
}
