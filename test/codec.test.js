import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack7, unpack7, encodeMessage, StreamDecoder, MsgWriter, MsgReader, toHex, fromHex } from '../src/spark/codec.js';
import * as M from '../src/spark/messages.js';
import { demoPresets } from '../src/spark/transport-mock.js';

test('7-bit pack/unpack round trip', () => {
  const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff);
  const packed = pack7(data);
  assert.ok(packed.every((b) => b < 0x80));
  assert.deepEqual(unpack7(packed), data);
});

test('get-current-preset-number matches known wire bytes', () => {
  // From Ignitron's hard-coded message: 01 fe 00 00 53 fe 17 00 ... f0 01 08 00 02 10 f7
  const [block] = encodeMessage(M.requestPresetNumber(), { seq: 0x08 });
  assert.equal(
    toHex(block),
    '01 fe 00 00 53 fe 17 00 00 00 00 00 00 00 00 00 f0 01 08 00 02 10 f7',
  );
});

test('set-param encodes like the spec example (Twin gain)', () => {
  const [block] = encodeMessage(M.setParam('Twin', 0, 0.6306), { seq: 0x32 });
  const hex = toHex(block);
  // header, F0 01 seq chk 01 04, prefixed string 04 a4 "Twin" -> 7-bit packed
  assert.ok(hex.startsWith('01 fe 00 00 53 fe'));
  assert.equal(block[6], block.length);
  assert.ok(hex.includes('f0 01 32'));
  assert.ok(hex.includes('01 04'));
  assert.ok(hex.endsWith('f7'));
});

test('set-param ends with the input byte (Spark 2 ignores 01 04 without it)', () => {
  const { data } = M.setParam('Twin', 0, 0.6306);
  // 04 a4 "Twin", fixint 00, float32 ca xx xx xx xx, input 00
  assert.equal(toHex(data), toHex(new MsgWriter().prefixedStr('Twin').byte(0).float(0.6306).byte(0).toBytes()));
  assert.equal(data.at(-1), 0x00);
  assert.equal(data.at(-6), 0xca);
  assert.equal(M.setParam('Twin', 0, 0.5, 1).data.at(-1), 0x01);
  const msg = M.decode({ cmd: 0x01, sub: 0x04, data });
  assert.equal(msg.effect, 'Twin');
  assert.equal(msg.input, 0);
});

test('spec figure 9: LA2AComp param decodes', () => {
  // Data from "Figure 9" of Paul Hamshere's protocol description
  const chunk = fromHex('f0 01 32 40 01 04 02 08 28 4c 41 32 41 43 10 6f 6d 70 01 4a 3f 4d 02 42 44 f7');
  const out = [];
  const d = new StreamDecoder((m) => out.push(m));
  d.push(chunk);
  assert.equal(out.length, 1);
  const msg = M.decode(out[0]);
  assert.equal(msg.type, 'param');
  assert.equal(msg.effect, 'LA2AComp');
  assert.equal(msg.index, 1);
  assert.ok(Math.abs(msg.value - 0.8018) < 0.001, `value ${msg.value}`);
  assert.equal(msg.input, undefined); // the spec figure predates the input byte
});

test('decoder copes with headers splitting chunks and random fragmenting', () => {
  const preset = demoPresets()[2];
  const data = M.presetWriter(preset, 1).toBytes();
  const blocks = encodeMessage({ cmd: 0x03, sub: 0x01, data }, { seq: 5, direction: 'fromAmp' });
  assert.ok(blocks.length > 2, 'preset should span several blocks');
  assert.ok(blocks.every((b) => b.length <= 0x6a));
  const stream = blocks.flatMap((b) => Array.from(b));
  for (const size of [1, 3, 7, 20, 64, 512]) {
    const out = [];
    const dec = new StreamDecoder((m) => out.push(m));
    for (let i = 0; i < stream.length; i += size) dec.push(stream.slice(i, i + size));
    assert.equal(out.length, 1, `fragment size ${size}`);
    assert.ok(out[0].checksumOk);
    const p = M.parsePreset(out[0].data);
    assert.equal(p.name, preset.name);
    assert.equal(p.slot, 1);
    assert.ok(p.checksumOk);
    assert.deepEqual(
      p.pedals.map((f) => f.name),
      preset.pedals.map((f) => f.name),
    );
    assert.deepEqual(p.pedals[3].params, preset.pedals[3].params.map(Math.fround));
  }
});

test('preset upload: each block fits 0xAD, sub-header counts chunks', () => {
  const data = M.sendPreset(demoPresets()[0]).data;
  const blocks = encodeMessage({ cmd: 0x01, sub: 0x01, data }, { seq: 9 });
  assert.ok(blocks.every((b) => b.length <= 0xad && b[6] === b.length));
  const out = [];
  const dec = new StreamDecoder((m) => out.push(m));
  blocks.forEach((b) => dec.push(b));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].data, data);
});

test('msgpack writer/reader round trip', () => {
  const w = new MsgWriter().int(5).int(200).int(4045).bool(true).str('hello').longStr('x'.repeat(40)).prefixedStr('Twin').float(0.25);
  const r = new MsgReader(w.toBytes());
  assert.equal(r.int(), 5);
  assert.equal(r.int(), 200);
  assert.equal(r.int(), 4045);
  assert.equal(r.bool(), true);
  assert.equal(r.str(), 'hello');
  assert.equal(r.str(), 'x'.repeat(40));
  assert.equal(r.str(), 'Twin');
  assert.equal(r.float(), 0.25);
  assert.equal(r.remaining, 0);
});

test('garbage between chunks is ignored', () => {
  const [block] = encodeMessage(M.requestAmpName(), { seq: 3 });
  const out = [];
  const dec = new StreamDecoder((m) => out.push(m));
  dec.push([0x00, 0x13, 0x88]);
  dec.push(block);
  assert.equal(out.length, 1);
  assert.equal(out[0].sub, 0x11);
});

test('real Spark 40 capture: 03 01 preset spanning 7 blocks', async () => {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(new URL('./fixtures/spark40-preset-rx.txt', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  const out = [];
  const errors = [];
  const dec = new StreamDecoder((m) => out.push(m), { onError: (e) => errors.push(e) });
  for (const l of lines) dec.push(fromHex(l));
  assert.deepEqual(errors, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].cmd, 0x03);
  assert.equal(out[0].sub, 0x01);
  assert.ok(out[0].checksumOk);
  const p = M.parsePreset(out[0].data);
  assert.equal(p.slot, 0);
  assert.ok(p.checksumOk, 'preset checksum');
  assert.deepEqual(
    p.pedals.map((f) => f.name),
    ['bias.noisegate', 'Compressor', 'Booster', 'Twin', 'ChorusAnalog', 'DelayMono', 'bias.reverb'],
  );
  assert.equal(p.pedals[4].isOn, false);
  assert.equal(p.pedals[3].params.length, 5);
  // re-encoding the parsed preset reproduces the amp's payload exactly
  assert.deepEqual(M.presetWriter(p, 0).toBytes(), out[0].data);
});
