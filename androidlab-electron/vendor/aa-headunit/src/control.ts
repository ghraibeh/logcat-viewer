import { AapTransport } from './frame';
import { AapCrypto } from './crypto';
import * as C from './consts';
import * as P from './proto';
import { buildServiceDiscoveryResponse, HuConfig } from './discovery';

/**
 * Control-channel handshake, modern Android Auto protocol (port of ControlChannel.kt):
 *
 *   HU → version request → phone → version response
 *   HU ⇄ TLS handshake (ENCAPSULATED_SSL messages, AapCrypto as client)
 *   HU → auth complete (status = success)
 *   phone → service discovery REQUEST → HU → service discovery RESPONSE
 *   phone → audio-focus / nav-focus requests → HU grants
 *   ping both ways (HU pings ~1/s — AA drops a head unit that stops pinging)
 */
export class ControlChannel {
  onPhoneInfo: ((name: string, brand: string) => void) | undefined;
  onSessionEnd: ((reason: string) => void) | undefined;

  private pingTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly transport: AapTransport,
    private readonly crypto: AapCrypto,
    private readonly config: HuConfig,
    private readonly onStatus: (msg: string) => void,
  ) {}

  async begin(): Promise<void> {
    await this.transport.sendMessage(
      C.CH_CONTROL,
      P.ControlMsg.VERSION_REQUEST,
      Buffer.concat([C.u16be(C.VERSION_MAJOR), C.u16be(C.VERSION_MINOR)]),
      false,
    );
    this.onStatus('Handshake: version request sent…');
  }

  async onMessage(messageId: number, content: Buffer): Promise<void> {
    switch (messageId) {
      case P.ControlMsg.VERSION_RESPONSE:
        return this.onVersionResponse(content);
      case P.ControlMsg.SSL_HANDSHAKE:
        return this.onSslHandshake(content);
      case P.ControlMsg.SERVICE_DISCOVERY_REQUEST:
        return this.onServiceDiscoveryRequest(content);
      case P.ControlMsg.AUDIO_FOCUS_REQUEST:
        return this.onAudioFocusRequest(content);
      case P.ControlMsg.NAV_FOCUS_REQUEST:
        return this.onNavFocusRequest();
      case P.ControlMsg.PING_REQUEST:
        return this.respondPing(content);
      case P.ControlMsg.PING_RESPONSE:
        return; // our keepalive ack'd
      case P.ControlMsg.BYEBYE_REQUEST:
        return this.onByeBye(content);
      default:
        this.onStatus(`unhandled control id=0x${messageId.toString(16).padStart(4, '0')}`);
    }
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private async onVersionResponse(content: Buffer): Promise<void> {
    const major = content.length >= 2 ? C.readU16(content, 0) : 0;
    const minor = content.length >= 4 ? C.readU16(content, 2) : 0;
    const status = content.length >= 6 ? C.readU16(content, 4) : -1;
    this.onStatus(`Version ${major}.${minor} status=${status} — starting TLS…`);
    const hello = await this.crypto.startHandshake();
    await this.transport.sendMessage(C.CH_CONTROL, P.ControlMsg.SSL_HANDSHAKE, hello, false);
  }

  private async onSslHandshake(content: Buffer): Promise<void> {
    const out = await this.crypto.processHandshake(content);
    if (out.length > 0) {
      await this.transport.sendMessage(C.CH_CONTROL, P.ControlMsg.SSL_HANDSHAKE, out, false);
    }
    if (this.crypto.finished) {
      this.onStatus('TLS established — auth complete…');
      await this.transport.sendMessage(C.CH_CONTROL, P.ControlMsg.AUTH_COMPLETE, P.authComplete(), false);
      this.startPinging();
    }
  }

  private async onServiceDiscoveryRequest(content: Buffer): Promise<void> {
    const { phoneName, phoneBrand } = P.parseServiceDiscoveryRequest(content);
    if (phoneName || phoneBrand) this.onPhoneInfo?.(phoneName ?? '?', phoneBrand ?? '?');
    await this.transport.sendMessage(
      C.CH_CONTROL,
      P.ControlMsg.SERVICE_DISCOVERY_RESPONSE,
      buildServiceDiscoveryResponse(this.config),
      true,
    );
    this.onStatus('Service discovery answered — waiting for channels…');
  }

  /** Map the phone's focus request to the correct state (RELEASE→LOSS, GAIN→GAIN, …) —
   *  responding GAIN to a RELEASE makes the phone re-request forever and never open channels. */
  private async onAudioFocusRequest(content: Buffer): Promise<void> {
    const req = P.parseAudioFocusRequest(content);
    const state =
      req === P.AudioFocusRequestType.RELEASE
        ? P.AudioFocusState.LOSS
        : req === P.AudioFocusRequestType.GAIN_TRANSIENT
          ? P.AudioFocusState.GAIN_TRANSIENT
          : req === P.AudioFocusRequestType.GAIN_TRANSIENT_MAY_DUCK
            ? P.AudioFocusState.GAIN_TRANSIENT_GUIDANCE_ONLY
            : P.AudioFocusState.GAIN;
    await this.transport.sendMessage(
      C.CH_CONTROL,
      P.ControlMsg.AUDIO_FOCUS_NOTIFICATION,
      P.audioFocusNotification(state, false),
      true,
    );
    this.onStatus(`Audio focus → state ${state}.`);
  }

  private async onNavFocusRequest(): Promise<void> {
    await this.transport.sendMessage(
      C.CH_CONTROL,
      P.ControlMsg.NAV_FOCUS_NOTIFICATION,
      P.navFocusNotification(P.NavFocusType.NAV_FOCUS_2),
      true,
    );
  }

  private async onByeBye(content: Buffer): Promise<void> {
    const reason = P.parseByeByeReason(content);
    await this.transport.sendMessage(C.CH_CONTROL, P.ControlMsg.BYEBYE_RESPONSE, P.byeByeResponse(), true);
    this.onSessionEnd?.(`phone ended the session (byebye reason=${reason ?? '?'})`);
  }

  private async respondPing(content: Buffer): Promise<void> {
    // ECHO the phone's ping timestamp — AA matches the response to its outstanding request
    // by this value; replying with our own clock reads as "out of order ping response".
    const ts = P.parsePingTimestamp(content) ?? process.hrtime.bigint();
    await this.transport.sendMessage(C.CH_CONTROL, P.ControlMsg.PING_RESPONSE, P.pingResponse(ts), true);
  }

  /** ~1s cadence: AA flags "Missing HU ping requests" at ~3s and drops an unresponsive
   *  head unit. Real head units ping ~1/s. */
  private startPinging(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      void this.transport
        .sendMessage(C.CH_CONTROL, P.ControlMsg.PING_REQUEST, P.pingRequest(process.hrtime.bigint()), true)
        .catch(() => {});
    }, 1000);
    this.pingTimer.unref?.();
  }
}
