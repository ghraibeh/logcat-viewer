import { AapTransport } from './frame';
import * as C from './consts';
import * as P from './proto';

/**
 * Non-control channels (ports of SensorChannel.kt / MediaChannel.kt / InputChannel.kt).
 */

/** Sensor channel — MANDATORY. Driving status is THE projection gate: AA will not start
 *  video until it knows the car is parked, and it often never asks (no SensorStartRequest),
 *  so the session pushes it unsolicited the moment the channel opens. */
export class SensorChannel {
  constructor(
    private readonly transport: AapTransport,
    private readonly onStatus: (msg: string) => void,
  ) {}

  async onMessage(messageId: number, content: Buffer): Promise<void> {
    if (messageId === P.SensorMsg.START_REQUEST) return this.onSensorStart(content);
    this.onStatus(`sensor msg 0x${messageId.toString(16)}`);
  }

  async pushDrivingStatus(): Promise<void> {
    await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.EVENT, P.sensorEventDrivingStatus(), true);
    this.onStatus('Driving status → parked/unrestricted (projection gate unlocked).');
  }

  private async onSensorStart(content: Buffer): Promise<void> {
    const type = P.parseSensorRequestType(content);
    await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.START_RESPONSE, P.sensorStartResponse(), true);
    if (type === P.SensorType.DRIVING_STATUS) {
      await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.EVENT, P.sensorEventDrivingStatus(), true);
    } else if (type === P.SensorType.NIGHT) {
      await this.transport.sendMessage(C.CH_SENSOR, P.SensorMsg.EVENT, P.sensorEventNight(false), true);
    }
    this.onStatus(`Sensor ${type ?? '?'} started.`);
  }
}

/** A media channel: one instance per video / audio-sink / mic channel. Handles the phone's
 *  setup → config, start, video-focus and microphone requests, and the media data stream.
 *  Data payloads are surfaced via onData (video: Annex-B H.264; audio: PCM). */
export class MediaChannel {
  /** (payload with the 8-byte timestamp already stripped, isCodecConfig) */
  onData: ((payload: Buffer, codecConfig: boolean) => void) | undefined;
  /** Mic (this channel only): the phone opened/closed the microphone (Assistant/voice). */
  onMic: ((open: boolean) => void) | undefined;

  private session = 0;

  constructor(
    readonly channelId: number,
    private readonly transport: AapTransport,
    private readonly onStatus: (msg: string) => void,
  ) {}

  async onMessage(messageId: number, content: Buffer): Promise<void> {
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

  private async onSetup(): Promise<void> {
    await this.send(P.MediaMsg.CONFIG, P.mediaConfig());
    this.onStatus(`${C.channelName(this.channelId)} set up.`);
    if (this.channelId === C.CH_VIDEO) await this.gainVideoFocus();
    if (C.isAudio(this.channelId)) {
      // Grant audio focus (unsolicited) on the control channel so the phone routes audio here.
      await this.transport.sendMessage(
        C.CH_CONTROL,
        P.ControlMsg.AUDIO_FOCUS_NOTIFICATION,
        P.audioFocusNotification(P.AudioFocusState.GAIN, true),
        true,
      );
    }
  }

  /** Tell the phone the head unit is displaying AA (unsolicited PROJECTED focus). This is
   *  what prompts the phone to set up + start the video stream. */
  async gainVideoFocus(): Promise<void> {
    await this.send(P.MediaMsg.VIDEO_FOCUS_NOTIFICATION, P.videoFocusNotification());
    this.onStatus('Video focus PROJECTED — awaiting stream…');
  }

  private async onDataMsg(content: Buffer, hasTimestamp: boolean): Promise<void> {
    const off = hasTimestamp && content.length > 8 ? 8 : 0; // strip 8-byte timestamp
    if (content.length > off) this.onData?.(content.subarray(off), !hasTimestamp);
    await this.send(P.MediaMsg.ACK, P.mediaAck(this.session));
  }

  private async onMicRequest(content: Buffer): Promise<void> {
    const open = P.parseMicrophoneOpen(content);
    await this.send(P.MediaMsg.MICROPHONE_RESPONSE, P.microphoneResponse(this.session));
    this.onStatus(open ? 'Mic open — listening…' : 'Mic closed.');
    this.onMic?.(open);
  }

  /** Stream a chunk of captured mic PCM to the phone, framed like media data:
   *  [timestamp:8 BE µs][pcm]. 16-bit mono at the advertised mic rate (16 kHz). */
  sendMicData(pcm: Buffer): Promise<void> {
    const tsUs = process.hrtime.bigint() / 1000n;
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(tsUs & 0xffffffffffffffffn);
    return this.send(P.MediaMsg.DATA, Buffer.concat([header, pcm]));
  }

  private send(messageId: number, content: Buffer): Promise<void> {
    return this.transport.sendMessage(this.channelId, messageId, content, true);
  }
}

/** Input channel — the touch-forwarding path. Answers the phone's key-binding request, then
 *  pushes InputReport touch events in display coordinates. */
export class InputChannel {
  constructor(
    private readonly transport: AapTransport,
    private readonly displayW: number,
    private readonly displayH: number,
    private readonly onStatus: (msg: string) => void,
  ) {}

  async onMessage(messageId: number, _content: Buffer): Promise<void> {
    if (messageId === P.InputMsg.BINDING_REQUEST) {
      await this.transport.sendMessage(C.CH_INPUT, P.InputMsg.BINDING_RESPONSE, P.bindingResponse(), true);
      this.onStatus('Input bound — touch is live.');
      return;
    }
    this.onStatus(`input msg 0x${messageId.toString(16)}`);
  }

  sendTouch(action: number, x: number, y: number): Promise<void> {
    const cx = Math.max(0, Math.min(this.displayW, Math.round(x)));
    const cy = Math.max(0, Math.min(this.displayH, Math.round(y)));
    return this.transport.sendMessage(
      C.CH_INPUT,
      P.InputMsg.EVENT,
      P.inputReportTouch(process.hrtime.bigint(), cx, cy, action),
      true,
    );
  }
}
