import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBtsnoop, attToH4, decodeBtsnoop } from '../src/spark/btsnoop.js';
import { encodeMessage } from '../src/spark/codec.js';
import * as M from '../src/spark/messages.js';
import { demoPresets } from '../src/spark/transport-mock.js';

test('decodes Spark traffic out of a synthetic BLE HCI capture', () => {
  const packets = [];
  let t = 1_700_000_000_000;
  const conn = 0x0040;
  const WRITE_H = 0x0012;
  const NOTIFY_H = 0x0014;

  // unrelated ATT traffic that must be ignored
  packets.push(...attToH4(conn, [0x52, 0x30, 0x00, 1, 2, 3]).map((h4) => ({ received: false, timeMs: t++, h4 })));

  // app -> amp: request amp name (ATT write command)
  const [req] = encodeMessage(M.requestAmpName(), { seq: 1 });
  packets.push(...attToH4(conn, [0x52, WRITE_H & 0xff, WRITE_H >> 8, ...req]).map((h4) => ({ received: false, timeMs: t++, h4 })));

  // amp -> app: name reply
  const [rep] = encodeMessage({ cmd: 3, sub: 0x11, data: Uint8Array.from([8, 0xa8, ...Buffer.from('Spark 40')]) }, { seq: 1, direction: 'fromAmp' });
  packets.push(...attToH4(conn, [0x1b, NOTIFY_H & 0xff, NOTIFY_H >> 8, ...rep]).map((h4) => ({ received: true, timeMs: t++, h4 })));

  // amp -> app: multi-block preset, sent as several 20-byte notifications
  const presetData = M.presetWriter(demoPresets()[0], 0).toBytes();
  const blocks = encodeMessage({ cmd: 3, sub: 1, data: presetData }, { seq: 2, direction: 'fromAmp' });
  const stream = blocks.flatMap((b) => Array.from(b));
  for (let i = 0; i < stream.length; i += 20) {
    const part = stream.slice(i, i + 20);
    packets.push(...attToH4(conn, [0x1b, NOTIFY_H & 0xff, NOTIFY_H >> 8, ...part]).map((h4) => ({ received: true, timeMs: t++, h4 })));
  }

  const file = buildBtsnoop(packets);
  const { messages } = decodeBtsnoop(file);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].type, 'request');
  assert.equal(messages[0].direction, 'toAmp');
  assert.equal(messages[1].type, 'ampName');
  assert.equal(messages[1].name, 'Spark 40');
  assert.equal(messages[2].type, 'preset');
  assert.equal(messages[2].preset.name, 'Silver Clean');
});

test('decodes Spark traffic carried over RFCOMM (classic SPP)', () => {
  const conn = 0x0003;
  const remoteCid = 0x0041;
  const [req] = encodeMessage(M.selectPreset(2), { seq: 7 });
  // RFCOMM UIH frame on DLCI 2: addr, control, len(1 byte, EA), data, fcs
  const addr = (2 << 2) | 0x03;
  const rf = [addr, 0xef, (req.length << 1) | 1, ...req, 0x9a];
  const l2 = [rf.length & 0xff, rf.length >> 8, remoteCid & 0xff, remoteCid >> 8, ...rf];
  const h4 = Uint8Array.from([0x02, conn, 0x20, l2.length & 0xff, l2.length >> 8, ...l2]);
  const { messages } = decodeBtsnoop(buildBtsnoop([{ received: false, timeMs: 1, h4 }]));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'presetSelected');
  assert.equal(messages[0].slot, 2);
});
