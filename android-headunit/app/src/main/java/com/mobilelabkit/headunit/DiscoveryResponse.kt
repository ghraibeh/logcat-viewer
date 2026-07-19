package com.mobilelabkit.headunit

import com.andrerinas.headunitrevived.aap.protocol.proto.Control
import com.andrerinas.headunitrevived.aap.protocol.proto.Media
import com.andrerinas.headunitrevived.aap.protocol.proto.Sensors

/**
 * Builds the modern Android Auto service-discovery response (Control.ServiceDiscoveryResponse
 * with Control.Service entries). Android Auto refuses to project unless the head unit
 * advertises the full expected set — sensor (driving status), video sink, touchscreen input,
 * the three audio sinks, a microphone source (required for Assistant), media-playback status
 * and navigation status. Mirrors headunit-revived's ServiceDiscoveryResponse.
 */
object DiscoveryResponse {

    fun build(video: HeadUnitConfig.VideoConfig): ByteArray {
        val services = ArrayList<Control.Service>()

        // Sensor: driving status (safety gate) + night.
        services.add(Control.Service.newBuilder().apply {
            id = AapProto.CH_SENSOR
            sensorSourceService = Control.Service.SensorSourceService.newBuilder()
                .addSensors(Control.Service.SensorSourceService.Sensor.newBuilder().setType(Sensors.SensorType.DRIVING_STATUS))
                .addSensors(Control.Service.SensorSourceService.Sensor.newBuilder().setType(Sensors.SensorType.NIGHT))
                .build()
        }.build())

        // Video sink (H.264). Resolution/density come from the user's orientation choice +
        // the auto-detected panel size (HeadUnitConfig). AA only starts video when an advertised
        // config matches the display's orientation, so this MUST reflect portrait vs landscape.
        services.add(Control.Service.newBuilder().apply {
            id = AapProto.CH_VIDEO
            mediaSinkService = Control.Service.MediaSinkService.newBuilder().apply {
                availableType = Media.MediaCodecType.MEDIA_CODEC_VIDEO_H264_BP
                audioType = Media.AudioStreamType.NONE
                availableWhileInCall = true
                addVideoConfigs(
                    Control.Service.MediaSinkService.VideoConfiguration.newBuilder()
                        .setCodecResolution(video.resolution)
                        .setFrameRate(Control.Service.MediaSinkService.VideoConfiguration.VideoFrameRateType._30)
                        .setMarginWidth(0).setMarginHeight(0).setDensity(video.densityDpi)
                        .setVideoCodecType(Media.MediaCodecType.MEDIA_CODEC_VIDEO_H264_BP)
                        .build()
                )
            }.build()
        }.build())

        // Input (touchscreen) — sized to the negotiated video resolution.
        services.add(Control.Service.newBuilder().apply {
            id = AapProto.CH_INPUT
            inputSourceService = Control.Service.InputSourceService.newBuilder()
                .setTouchscreen(
                    Control.Service.InputSourceService.TouchConfig.newBuilder()
                        .setWidth(video.width).setHeight(video.height).build()
                ).build()
        }.build())

        // Audio sinks: system, speech, media.
        services.add(audioSink(AapProto.CH_AUDIO_SYSTEM, Media.AudioStreamType.SYSTEM, 16000, 16, 1))
        services.add(audioSink(AapProto.CH_AUDIO_SPEECH, Media.AudioStreamType.SPEECH, 16000, 16, 1))
        services.add(audioSink(AapProto.CH_AUDIO_MEDIA, Media.AudioStreamType.MEDIA, 48000, 16, 2))

        // Microphone source (required for the AA connection / Assistant).
        services.add(Control.Service.newBuilder().apply {
            id = AapProto.CH_MIC
            mediaSourceService = Control.Service.MediaSourceService.newBuilder()
                .setType(Media.MediaCodecType.MEDIA_CODEC_AUDIO_PCM)
                .setAudioConfig(
                    Media.AudioConfiguration.newBuilder()
                        .setSampleRate(16000).setNumberOfBits(16).setNumberOfChannels(1).build()
                ).build()
        }.build())

        // Media-playback status + navigation status.
        services.add(Control.Service.newBuilder().apply {
            id = AapProto.CH_MEDIA_PLAYBACK
            mediaPlaybackService = Control.Service.MediaPlaybackStatusService.newBuilder().build()
        }.build())
        services.add(Control.Service.newBuilder().apply {
            id = AapProto.CH_NAV
            navigationStatusService = Control.Service.NavigationStatusService.newBuilder()
                .setMinimumIntervalMs(1000)
                .setType(Control.Service.NavigationStatusService.ClusterType.ImageCodesOnly)
                .build()
        }.build())

        return Control.ServiceDiscoveryResponse.newBuilder()
            .addAllServices(services)
            .setMake("MobileLabKit")
            .setModel("MobileLabKit")
            .setYear("2026")
            .setVehicleId("MLK0001")
            .setDriverPosition(Control.DriverPosition.DRIVER_POSITION_LEFT)
            .setHeadUnitMake("MobileLabKit")
            .setHeadUnitModel("MobileLabKit HeadUnit")
            .setHeadUnitSoftwareBuild("1")
            .setHeadUnitSoftwareVersion("0.7")
            .setCanPlayNativeMediaDuringVr(false)
            .setHideProjectedClock(false)
            .setDisplayName("MobileLabKit")
            .setHeadunitInfo(
                com.andrerinas.headunitrevived.aap.protocol.proto.Common.HeadUnitInfo.newBuilder()
                    .setHeadUnitMake("MobileLabKit")
                    .setHeadUnitModel("MobileLabKit HeadUnit")
                    .setMake("MobileLabKit")
                    .setModel("MobileLabKit")
                    .setYear("2026")
                    .setVehicleId("MLK0001")
                    .setHeadUnitSoftwareBuild("1")
                    .setHeadUnitSoftwareVersion("0.7")
                    .build()
            )
            .build().toByteArray()
    }

    private fun audioSink(ch: Int, type: Media.AudioStreamType, rate: Int, bits: Int, channels: Int): Control.Service =
        Control.Service.newBuilder().apply {
            id = ch
            mediaSinkService = Control.Service.MediaSinkService.newBuilder()
                .setAvailableType(Media.MediaCodecType.MEDIA_CODEC_AUDIO_PCM)
                .setAudioType(type)
                .addAudioConfigs(
                    Media.AudioConfiguration.newBuilder()
                        .setSampleRate(rate).setNumberOfBits(bits).setNumberOfChannels(channels).build()
                ).build()
        }.build()
}
