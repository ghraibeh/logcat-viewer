package com.mobilelabkit.headunit

import android.util.Log
import com.andrerinas.headunitrevived.aap.protocol.proto.Common
import com.andrerinas.headunitrevived.aap.protocol.proto.Sensors

/**
 * Modern AA sensor channel (head-unit side) — MANDATORY. On the phone's sensor-start it
 * answers success and pushes the current reading: driving status = UNRESTRICTED (parked →
 * AA lifts its safety restrictions) and night mode = off.
 */
class SensorChannel(
    private val transport: AapTransport,
    private val onStatus: (String) -> Unit
) {
    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            Sensors.SensorsMsgType.SENSOR_STARTREQUEST_VALUE -> onSensorStart(content)
            else -> Log.d(TAG, "sensor msg 0x%04x".format(messageId))
        }
    }

    private fun onSensorStart(content: ByteArray) {
        val type = runCatching { Sensors.SensorRequest.parseFrom(content).type }.getOrNull()
        transport.sendMessage(
            AapProto.CH_SENSOR, Sensors.SensorsMsgType.SENSOR_STARTRESPONSE_VALUE,
            Sensors.SensorResponse.newBuilder().setStatus(Common.MessageStatus.STATUS_SUCCESS).build().toByteArray(),
            encrypted = true
        )
        val batch = when (type) {
            Sensors.SensorType.DRIVING_STATUS -> Sensors.SensorBatch.newBuilder()
                .addDrivingStatus(
                    Sensors.SensorBatch.DrivingStatusData.newBuilder()
                        .setStatus(Sensors.SensorBatch.DrivingStatusData.Status.UNRESTRICTED_VALUE)
                ).build()
            Sensors.SensorType.NIGHT -> Sensors.SensorBatch.newBuilder()
                .addNightMode(Sensors.SensorBatch.NightData.newBuilder().setIsNightMode(false))
                .build()
            else -> null
        }
        if (batch != null) {
            transport.sendMessage(
                AapProto.CH_SENSOR, Sensors.SensorsMsgType.SENSOR_EVENT_VALUE, batch.toByteArray(), encrypted = true
            )
        }
        onStatus("Sensor ${type?.name ?: "?"} started.")
    }

    companion object { private const val TAG = "headunit-sensor" }
}
