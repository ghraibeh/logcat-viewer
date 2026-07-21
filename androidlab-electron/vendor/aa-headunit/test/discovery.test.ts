import { test } from 'node:test';
import * as assert from 'node:assert';
import { buildServiceDiscoveryResponse, makeConfig } from '../src/discovery';
import { decodeFields, fieldNum } from '../src/pb';
import * as C from '../src/consts';

test('service discovery response advertises the full expected service set', () => {
  const buf = buildServiceDiscoveryResponse(makeConfig('1280x720'));
  const f = decodeFields(buf);

  const services = (f.get(1) ?? []) as Buffer[];
  assert.equal(services.length, 9, 'sensor, video, input, 3 audio, mic, media-playback, nav');

  const byId = new Map<number, Map<number, unknown[]>>();
  for (const s of services) {
    const sf = decodeFields(s);
    byId.set(fieldNum(sf, 1)!, sf as Map<number, unknown[]>);
  }

  // sensor service carries SensorSourceService (field 2) with 2 sensors
  const sensor = byId.get(C.CH_SENSOR)!;
  const sensorSrc = decodeFields(sensor.get(2)![0] as Buffer);
  assert.equal(sensorSrc.get(1)!.length, 2, 'driving status + night');

  // video sink: MediaSinkService (field 3) with one VideoConfiguration (field 4)
  const video = decodeFields(byId.get(C.CH_VIDEO)!.get(3)![0] as Buffer);
  assert.equal(fieldNum(video, 1), 3, 'availableType = H264_BP');
  const vconf = decodeFields(video.get(4)![0] as Buffer);
  assert.equal(fieldNum(vconf, 1), 2, 'codecResolution = 1280x720');
  assert.equal(fieldNum(vconf, 2), 2, 'frameRate = 30');
  assert.equal(fieldNum(vconf, 5), 240, 'density');
  assert.equal(fieldNum(vconf, 10), 3, 'videoCodecType = H264_BP');

  // input: touchscreen sized to the resolution
  const input = decodeFields(byId.get(C.CH_INPUT)!.get(4)![0] as Buffer);
  const touch = decodeFields(input.get(2)![0] as Buffer);
  assert.equal(fieldNum(touch, 1), 1280);
  assert.equal(fieldNum(touch, 2), 720);

  // audio sinks: PCM with the right stream types
  for (const [ch, streamType, rate, chans] of [
    [C.CH_AUDIO_SYSTEM, 2, 16000, 1],
    [C.CH_AUDIO_SPEECH, 1, 16000, 1],
    [C.CH_AUDIO_MEDIA, 3, 48000, 2],
  ] as const) {
    const sink = decodeFields(byId.get(ch)!.get(3)![0] as Buffer);
    assert.equal(fieldNum(sink, 1), 1, 'availableType = PCM');
    assert.equal(fieldNum(sink, 2), streamType);
    const ac = decodeFields(sink.get(3)![0] as Buffer);
    assert.equal(fieldNum(ac, 1), rate);
    assert.equal(fieldNum(ac, 3), chans);
  }

  // mic source, media playback (empty), nav status
  assert.ok(byId.get(C.CH_MIC)!.get(5), 'mediaSourceService present');
  assert.ok(byId.get(C.CH_MEDIA_PLAYBACK)!.get(9), 'mediaPlaybackService present');
  const nav = decodeFields(byId.get(C.CH_NAV)!.get(8)![0] as Buffer);
  assert.equal(fieldNum(nav, 1), 1000);
  assert.equal(fieldNum(nav, 2), 2, 'ImageCodesOnly');

  // top-level identity fields
  assert.equal((f.get(4)![0] as Buffer).toString(), '2026', 'year is a STRING');
  assert.ok(f.get(17), 'headunitInfo present');
  assert.equal(fieldNum(f, 6), 0, 'driverPosition LEFT');
});
