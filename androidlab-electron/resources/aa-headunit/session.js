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
exports.AaSession = void 0;
const frame_1 = require("./frame");
const control_1 = require("./control");
const channels_1 = require("./channels");
const C = __importStar(require("./consts"));
const P = __importStar(require("./proto"));
class AaSession {
    crypto;
    ev;
    transport;
    control;
    sensor;
    input;
    media = new Map();
    streaming = false;
    stopped = false;
    focusTimer;
    constructor(link, crypto, cfg, ev, onLog) {
        this.crypto = crypto;
        this.ev = ev;
        const status = (m) => this.ev.status?.(m);
        this.transport = new frame_1.AapTransport(link, crypto, (ch, _enc, id, content) => this.route(ch, id, content));
        this.transport.onLog = onLog;
        this.transport.onError = (msg) => this.end(msg);
        this.control = new control_1.ControlChannel(this.transport, crypto, cfg, status);
        this.control.onPhoneInfo = (n, b) => this.ev.phoneInfo?.(n, b);
        this.control.onSessionEnd = (reason) => this.end(reason);
        this.sensor = new channels_1.SensorChannel(this.transport, status);
        this.input = new channels_1.InputChannel(this.transport, cfg.width, cfg.height, status);
        for (const ch of [C.CH_VIDEO, C.CH_AUDIO_MEDIA, C.CH_AUDIO_SPEECH, C.CH_AUDIO_SYSTEM, C.CH_MIC]) {
            const mc = new channels_1.MediaChannel(ch, this.transport, status);
            mc.onData = (payload, codecConfig) => this.onMediaData(ch, payload, codecConfig);
            if (ch === C.CH_MIC)
                mc.onMic = (open) => this.ev.micOpen?.(open);
            this.media.set(ch, mc);
        }
    }
    async start() {
        this.transport.start();
        await this.control.begin();
    }
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        if (this.focusTimer)
            clearInterval(this.focusTimer);
        this.focusTimer = undefined;
        this.control.stop();
        this.transport.stop();
        this.crypto.destroy();
    }
    sendTouch(action, x, y) {
        return this.input.sendTouch(action, x, y);
    }
    /** Feed a chunk of captured mic PCM (16-bit mono 16 kHz) to the phone's mic channel. */
    sendMic(pcm) {
        return this.media.get(C.CH_MIC)?.sendMicData(pcm) ?? Promise.resolve();
    }
    async route(ch, id, content) {
        // Channel-open (control msg 7) can arrive on ANY channel — answer generically.
        if (id === P.ControlMsg.CHANNEL_OPEN_REQUEST) {
            await this.transport.sendMessage(ch, P.ControlMsg.CHANNEL_OPEN_RESPONSE, P.channelOpenResponse(), true);
            this.ev.channelOpened?.(ch);
            // The moment the SENSOR channel opens, push driving status = UNRESTRICTED unsolicited.
            // This is the projection safety gate — AA does NOT ask for it (no SensorStartRequest).
            if (ch === C.CH_SENSOR)
                await this.sensor.pushDrivingStatus();
            // Once the video channel is open, keep telling the phone we're displaying AA until
            // video actually flows (headunit-revived re-sends unsolicited video focus every 1.5s).
            if (ch === C.CH_VIDEO)
                this.startVideoFocusWatchdog();
            return;
        }
        switch (ch) {
            case C.CH_CONTROL:
                return this.control.onMessage(id, content);
            case C.CH_SENSOR:
                return this.sensor.onMessage(id, content);
            case C.CH_INPUT:
                return this.input.onMessage(id, content);
            default: {
                const mc = this.media.get(ch);
                if (mc)
                    return mc.onMessage(id, content);
                this.ev.status?.(`msg on ${C.channelName(ch)} id=0x${id.toString(16)}`);
            }
        }
    }
    onMediaData(ch, payload, codecConfig) {
        if (ch === C.CH_VIDEO) {
            if (!this.streaming) {
                this.streaming = true;
                this.ev.streaming?.();
            }
            this.ev.videoData?.(payload, codecConfig);
        }
        else {
            this.ev.audioData?.(ch, payload);
        }
    }
    startVideoFocusWatchdog() {
        if (this.focusTimer)
            return;
        this.focusTimer = setInterval(() => {
            if (this.stopped || this.streaming) {
                if (this.focusTimer)
                    clearInterval(this.focusTimer);
                this.focusTimer = undefined;
                return;
            }
            void this.media.get(C.CH_VIDEO)?.gainVideoFocus().catch(() => { });
        }, 1500);
        this.focusTimer.unref?.();
    }
    end(reason) {
        if (this.stopped)
            return;
        this.stop();
        this.ev.ended?.(reason);
    }
}
exports.AaSession = AaSession;
