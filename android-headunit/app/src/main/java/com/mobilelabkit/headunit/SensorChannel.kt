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

    /**
     * THE projection gate. Android Auto will NOT start video (won't send Media Sink Setup)
     * until it knows the car is parked. headunit-revived pushes this UNSOLICITED the moment
     * the sensor channel opens — it does NOT wait for a SensorStartRequest (the phone often
     * never sends one). Driving status = UNRESTRICTED → AA lifts restrictions and projects.
     */
    fun pushDrivingStatus() {
        val batch = Sensors.SensorBatch.newBuilder()
            .addDrivingStatus(
                Sensors.SensorBatch.DrivingStatusData.newBuilder()
                    .setStatus(Sensors.SensorBatch.DrivingStatusData.Status.UNRESTRICTED_VALUE)
            ).build()
        transport.sendMessage(
            AapProto.CH_SENSOR, Sensors.SensorsMsgType.SENSOR_EVENT_VALUE, batch.toByteArray(), encrypted = true
        )
        Log.i(TAG, "pushed unsolicited driving status = UNRESTRICTED (projection gate)")
        onStatus("Driving status → parked (projection unlocked).")
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
