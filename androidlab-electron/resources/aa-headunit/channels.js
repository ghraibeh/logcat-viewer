"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputChannel = exports.MediaChannel = exports.SensorChannel = void 0;
const C = __importStar(require("./consts"));
const P = __importStar(require("./proto"));
/**
 * Non-control channels (ports of SensorChannel.kt / MediaChannel.kt / InputChannel.kt).
 */
/** Sensor channel — MANDATORY. Driving status is THE projection gate: AA will not start
 *  video until it knows the car is parked, and it often never asks (no SensorStartRequest),
 *  so the session pushes it unsolicited the moment the channel opens. */
class SensorChannel {
    transport;
    onStatus;
    constructor(transport, onStatus) {
        this.transport = transport;
        this.onStatus = onStatus;
    }
    async onMessage(messageId, content) {
        if (messageId === P.SensorMsg.START_REQUEST)
            return this.onSensorStart(content);
        this.onStatus(`sensor msg 0x${messageId.toString(16)}`);
    }
    async pushDrivingStatus() {
        await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.EVENT, P.sensorEventDrivingStatus(), true);
        this.onStatus('Driving status → parked/unrestricted (projection gate unlocked).');
    }
    async onSensorStart(content) {
        const type = P.parseSensorRequestType(content);
        await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.START_RESPONSE, P.sensorStartResponse(), true);
        if (type === P.SensorType.DRIVING_STATUS) {
            await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.EVENT, P.sensorEventDrivingStatus(), true);
        }
        else if (type === P.SensorType.NIGHT) {
            await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.EVENT, P.sensorEventNight(false), true);
        }
        this.onStatus(`Sensor ${type ?? '?'} started.`);
    }
}
exports.SensorChannel = SensorChannel;
/** A media channel: one instance per video / audio-sink / mic channel. Handles the phone's
 *  setup → config, start, video-focus and microphone requests, and the media data stream.
 *  Data payloads are surfaced via onData (video: Annex-B H.264; audio: PCM). */
class MediaChannel {
    channelId;
    transport;
    onStatus;
    /** (payload with the 8-byte timestamp already stripped, isCodecConfig) */
    onData;
    /** Mic (this channel only): the phone opened/closed the microphone (Assistant/voice). */
    onMic;
    session = 0;
    constructor(channelId, transport, onStatus) {
        this.channelId = channelId;
        this.transport = transport;
        this.onStatus = onStatus;
    }
    async onMessage(messageId, content) {
        switch (messageId) {
            case P.MediaMsg.SETUP:
                return this.onSetup();
            case P.MediaMsg.START:
                this.session = P.parseMediaStartSession(content);
                this.onStatus(`${C.channelName(this.channelId)} streaming (session ${this.session})…`);
                return;
            case P.MediaMsg.STOP:
                return;
            case P.MediaMsg.VIDEO_FOCUS_REQUEST:
                return this.gainVideoFocus();
            case P.MediaMsg.MICROPHONE_REQUEST:
                return this.onMicRequest(content);
            case P.MediaMsg.DATA:
                return this.onDataMsg(content, true);
            case P.MediaMsg.CODEC_CONFIG:
                return this.onDataMsg(content, false);
            default:
                this.onStatus(`media[${C.channelName(this.channelId)}] msg 0x${messageId.toString(16)}`);
        }
    }
    async onSetup() {
        await this.send(P.MediaMsg.CONFIG, P.mediaConfig());
        this.onStatus(`${C.channelName(this.channelId)} set up.`);
        if (this.channelId === C.CH_VIDEO)
            await this.gainVideoFocus();
        if (C.isAudio(this.channelId)) {
            // Grant audio focus (unsolicited) on the control channel so the phone routes audio here.
            await this.transport.sendMessage(C.CH_CONTROL, P.ControlMsg.AUDIO_FOCUS_NOTIFICATION, P.audioFocusNotification(P.AudioFocusState.GAIN, true), true);
        }
    }
    /** Tell the phone the head unit is displaying AA (unsolicited PROJECTED focus). This is
     *  what prompts the phone to set up + start the video stream. */
    async gainVideoFocus() {
        await this.send(P.MediaMsg.VIDEO_FOCUS_NOTIFICATION, P.videoFocusNotification());
        this.onStatus('Video focus PROJECTED — awaiting stream…');
    }
    async onDataMsg(content, hasTimestamp) {
        const off = hasTimestamp && content.length > 8 ? 8 : 0; // strip 8-byte timestamp
        if (content.length > off)
            this.onData?.(content.subarray(off), !hasTimestamp);
        await this.send(P.MediaMsg.ACK, P.mediaAck(this.session));
    }
    async onMicRequest(content) {
        const open = P.parseMicrophoneOpen(content);
        await this.send(P.MediaMsg.MICROPHONE_RESPONSE, P.microphoneResponse(this.session));
        this.onStatus(open ? 'Mic open — listening…' : 'Mic closed.');
        this.onMic?.(open);
    }
    /** Stream a chunk of captured mic PCM to the phone, framed like media data:
     *  [timestamp:8 BE µs][pcm]. 16-bit mono at the advertised mic rate (16 kHz). */
    sendMicData(pcm) {
        const tsUs = process.hrtime.bigint() / 1000n;
        const header = Buffer.alloc(8);
        header.writeBigUInt64BE(tsUs & 0xffffffffffffffffn);
        return this.send(P.MediaMsg.DATA, Buffer.concat([header, pcm]));
    }
    send(messageId, content) {
        return this.transport.sendMessage(this.channelId, messageId, content, true);
    }
}
exports.MediaChannel = MediaChannel;
/** Input channel — the touch-forwarding path. Answers the phone's key-binding request, then
 *  pushes InputReport touch events in display coordinates. */
class InputChannel {
    transport;
    displayW;
    displayH;
    onStatus;
    constructor(transport, displayW, displayH, onStatus) {
        this.transport = transport;
        this.displayW = displayW;
        this.displayH = displayH;
        this.onStatus = onStatus;
    }
    async onMessage(messageId, _content) {
        if (messageId === P.InputMsg.BINDING_REQUEST) {
            await this.transport.sendMessage(C.CH_INPUT, P.InputMsg.BINDING_RESPONSE, P.bindingResponse(), true);
            this.onStatus('Input bound — touch is live.');
            return;
        }
        this.onStatus(`input msg 0x${messageId.toString(16)}`);
    }
    sendTouch(action, x, y) {
        const cx = Math.max(0, Math.min(this.displayW, Math.round(x)));
        const cy = Math.max(0, Math.min(this.displayH, Math.round(y)));
        return this.transport.sendMessage(C.CH_INPUT, P.InputMsg.EVENT, P.inputReportTouch(process.hrtime.bigint(), cx, cy, action), true);
    }
}
exports.InputChannel = InputChannel;
