import { test } from 'node:test';
import * as assert from 'node:assert';
import { MediaChannel } from '../src/channels';
import { AapTransport } from '../src/frame';
import { PbWriter } from '../src/pb';
import * as C from '../src/consts';
import { MediaMsg } from '../src/proto';

interface Sent {
  ch: number;
  id: number;
  content: Buffer;
  enc: boolean;
}

function fakeTransport(sent: Sent[]): AapTransport {
  return {
    sendMessage: async (ch: number, id: number, content: Buffer, enc: boolean) => {
      sent.push({ ch, id, content, enc });
    },
  } as unknown as AapTransport;
}

test('sendMicData frames MEDIA_DATA = [ts:8 BE][pcm], encrypted, on the mic channel', async () => {
  const sent: Sent[] = [];
  const mc = new MediaChannel(C.CH_MIC, fakeTransport(sent), () => {});
  await mc.sendMicData(Buffer.from([1, 2, 3, 4]));
  assert.equal(sent.length, 1);
  const s = sent[0];
  assert.equal(s.ch, C.CH_MIC);
  assert.equal(s.id, MediaMsg.DATA);
  assert.equal(s.enc, true);
  assert.equal(s.content.length, 12); // 8-byte timestamp + 4 PCM bytes
  assert.deepEqual([...s.content.subarray(8)], [1, 2, 3, 4]);
  // Timestamp is a plausible non-zero monotonic microsecond value.
  assert.ok(s.content.readBigUInt64BE(0) > 0n);
});

test('MICROPHONE_REQUEST(open) → responds + fires onMic(open)', async () => {
  const sent: Sent[] = [];
  const mc = new MediaChannel(C.CH_MIC, fakeTransport(sent), () => {});
  let opened: boolean | undefined;
  mc.onMic = (o) => {
    opened = o;
  };
  // MicrophoneRequest { open(1) = true }
  await mc.onMessage(MediaMsg.MICROPHONE_REQUEST, new PbWriter().bool(1, true).finish());
  assert.equal(opened, true);
  assert.ok(
    sent.some((s) => s.id === MediaMsg.MICROPHONE_RESPONSE),
    'a MicrophoneResponse must be sent',
  );

  // Close
  opened = undefined;
  await mc.onMessage(MediaMsg.MICROPHONE_REQUEST, new PbWriter().bool(1, false).finish());
  assert.equal(opened, false);
});
