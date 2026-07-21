import { AapTransport } from './frame';
import { AapCrypto } from './crypto';
import { AapLink } from './link';
import { ControlChannel } from './control';
import { SensorChannel, MediaChannel, InputChannel } from './channels';
import { HuConfig } from './discovery';
import * as C from './consts';
import * as P from './proto';

/**
 * One Android Auto head-unit session over an open link (port of the protocol wiring in
 * MainActivity.startAaProtocol): transport + control channel + sensor/input/media channels,
 * the generic channel-open responder, and the video-focus watchdog.
 */

export interface SessionEvents {
  status?: (msg: string) => void;
  phoneInfo?: (name: string, brand: string) => void;
  channelOpened?: (channel: number) => void;
  /** Video payloads: Annex-B H.264, 8-byte timestamp already stripped. */
  videoData?: (payload: Buffer, codecConfig: boolean) => void;
  /** Audio payloads: PCM (rate/channels per the advertised sink for that channel). */
  audioData?: (channel: number, payload: Buffer) => void;
  /** The phone opened/closed the mic (Assistant/voice) — capture + feed sendMic() while open. */
  micOpen?: (open: boolean) => void;
  streaming?: () => void;
  ended?: (reason: string) => void;
}

export class AaSession {
  private readonly transport: AapTransport;
  private readonly control: ControlChannel;
  private readonly sensor: SensorChannel;
  private readonly input: InputChannel;
  private readonly media = new Map<number, MediaChannel>();
  private streaming = false;
  private stopped = false;
  private focusTimer: NodeJS.Timeout | undefined;

  constructor(
    link: AapLink,
    private readonly crypto: AapCrypto,
    cfg: HuConfig,
    private readonly ev: SessionEvents,
    onLog?: (line: string) => void,
  ) {
    const status = (m: string) => this.ev.status?.(m);

    this.transport = new AapTransport(link, crypto, (ch, _enc, id, content) =>
      this.route(ch, id, content),
    );
    this.transport.onLog = onLog;
    this.transport.onError = (msg) => this.end(msg);

    this.control = new ControlChannel(this.transport, crypto, cfg, status);
    this.control.onPhoneInfo = (n, b) => this.ev.phoneInfo?.(n, b);
    this.control.onSessionEnd = (reason) => this.end(reason);

    this.sensor = new SensorChannel(this.transport, status);
    this.input = new InputChannel(this.transport, cfg.width, cfg.height, status);
    for (const ch of [C.CH_VIDEO, C.CH_AUDIO_MEDIA, C.CH_AUDIO_SPEECH, C.CH_AUDIO_SYSTEM, C.CH_MIC]) {
      const mc = new MediaChannel(ch, this.transport, status);
      mc.onData = (payload, codecConfig) => this.onMediaData(ch, payload, codecConfig);
      if (ch === C.CH_MIC) mc.onMic = (open) => this.ev.micOpen?.(open);
      this.media.set(ch, mc);
    }
  }

  async start(): Promise<void> {
    this.transport.start();
    await this.control.begin();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.focusTimer) clearInterval(this.focusTimer);
    this.focusTimer = undefined;
    this.control.stop();
    this.transport.stop();
    this.crypto.destroy();
  }

  sendTouch(action: number, x: number, y: number): Promise<void> {
    return this.input.sendTouch(action, x, y);
  }

  /** Feed a chunk of captured mic PCM (16-bit mono 16 kHz) to the phone's mic channel. */
  sendMic(pcm: Buffer): Promise<void> {
    return this.media.get(C.CH_MIC)?.sendMicData(pcm) ?? Promise.resolve();
  }

  private async route(ch: number, id: number, content: Buffer): Promise<void> {
    // Channel-open (control msg 7) can arrive on ANY channel — answer generically.
    if (id === P.ControlMsg.CHANNEL_OPEN_REQUEST) {
      await this.transport.sendMessage(ch, P.ControlMsg.CHANNEL_OPEN_RESPONSE, P.channelOpenResponse(), true);
      this.ev.channelOpened?.(ch);
      // The moment the SENSOR channel opens, push driving status = UNRESTRICTED unsolicited.
      // This is the projection safety gate — AA does NOT ask for it (no SensorStartRequest).
      if (ch === C.CH_SENSOR) await this.sensor.pushDrivingStatus();
      // Once the video channel is open, keep telling the phone we're displaying AA until
      // video actually flows (headunit-revived re-sends unsolicited video focus every 1.5s).
      if (ch === C.CH_VIDEO) this.startVideoFocusWatchdog();
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
        if (mc) return mc.onMessage(id, content);
        this.ev.status?.(`msg on ${C.channelName(ch)} id=0x${id.toString(16)}`);
      }
    }
  }

  private onMediaData(ch: number, payload: Buffer, codecConfig: boolean): void {
    if (ch === C.CH_VIDEO) {
      if (!this.streaming) {
        this.streaming = true;
        this.ev.streaming?.();
      }
      this.ev.videoData?.(payload, codecConfig);
    } else {
      this.ev.audioData?.(ch, payload);
    }
  }

  private startVideoFocusWatchdog(): void {
    if (this.focusTimer) return;
    this.focusTimer = setInterval(() => {
      if (this.stopped || this.streaming) {
        if (this.focusTimer) clearInterval(this.focusTimer);
        this.focusTimer = undefined;
        return;
      }
      void this.media.get(C.CH_VIDEO)?.gainVideoFocus().catch(() => {});
    }, 1500);
    this.focusTimer.unref?.();
  }

  private end(reason: string): void {
    if (this.stopped) return;
    this.stop();
    this.ev.ended?.(reason);
  }
}
