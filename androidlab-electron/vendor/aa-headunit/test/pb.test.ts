import { test } from 'node:test';
import * as assert from 'node:assert';
import { PbWriter, decodeFields, fieldNum, fieldBig } from '../src/pb';

test('varint roundtrip incl. boundaries', () => {
  const w = new PbWriter()
    .varint(1, 0)
    .varint(2, 127)
    .varint(3, 128)
    .varint(4, 300)
    .varint(5, 0x7fffffff)
    .varint(6, 123456789012345678n);
  const f = decodeFields(w.finish());
  assert.equal(fieldNum(f, 1), 0);
  assert.equal(fieldNum(f, 2), 127);
  assert.equal(fieldNum(f, 3), 128);
  assert.equal(fieldNum(f, 4), 300);
  assert.equal(fieldNum(f, 5), 0x7fffffff);
  assert.equal(fieldBig(f, 6), 123456789012345678n);
});

test('negative int encodes as 10-byte two’s-complement varint (proto int32/int64)', () => {
  const buf = new PbWriter().varint(1, -1).finish();
  // tag(1) + 10 varint bytes
  assert.equal(buf.length, 11);
  const f = decodeFields(buf);
  assert.equal(fieldBig(f, 1), 0xffffffffffffffffn);
});

test('bool/string/bytes/nested/repeated', () => {
  const inner = new PbWriter().varint(1, 42).string(2, 'hi');
  const w = new PbWriter()
    .bool(1, true)
    .string(2, 'MobileLabKit')
    .bytes(3, Buffer.from([1, 2, 3]))
    .msg(4, inner)
    .msg(4, new PbWriter().varint(1, 43));
  const f = decodeFields(w.finish());
  assert.equal(fieldNum(f, 1), 1);
  assert.equal((f.get(2)![0] as Buffer).toString(), 'MobileLabKit');
  assert.deepEqual([...(f.get(3)![0] as Buffer)], [1, 2, 3]);
  const reps = f.get(4)!;
  assert.equal(reps.length, 2);
  const inner0 = decodeFields(reps[0] as Buffer);
  assert.equal(fieldNum(inner0, 1), 42);
  assert.equal((inner0.get(2)![0] as Buffer).toString(), 'hi');
  const inner1 = decodeFields(reps[1] as Buffer);
  assert.equal(fieldNum(inner1, 1), 43);
});

test('decode rejects truncated input', () => {
  const good = new PbWriter().bytes(1, Buffer.alloc(10)).finish();
  assert.throws(() => decodeFields(good.subarray(0, good.length - 1)));
  assert.throws(() => decodeFields(Buffer.from([0x08]))); // tag then EOF
});
