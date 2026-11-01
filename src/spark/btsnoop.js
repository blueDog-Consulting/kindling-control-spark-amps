// Parser for Android "Bluetooth HCI snoop log" files (btsnoop_hci.log) that
// extracts Spark traffic, so you can see exactly what the official app sends.
//
// Handles: btsnoop container (datalink 1001/1002), ACL fragmentation, L2CAP
// reassembly, ATT writes / notifications / long (prepared) writes for BLE, and
// RFCOMM UIH frames for Bluetooth Classic (SPP) — the Android app has used both.
//
// Usage:
//   const { fragments, messages } = decodeBtsnoop(uint8array);

import { StreamDecoder } from './codec.js';
import { decode } from './messages.js';

const BTSNOOP_EPOCH_DELTA_US = 0x00dcddb30f2f8000n; // 0000-01-01 -> 1970-01-01

const SIG_TO = [0x01, 0xfe, 0x00, 0x00, 0x53, 0xfe];
const SIG_FROM = [0x01, 0xfe, 0x00, 0x00, 0x41, 0xff];

export function parseBtsnoopRecords(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(...u8.subarray(0, 8));
  if (magic !== 'btsnoop\0') throw new Error('not a btsnoop file (bad magic)');
  const datalink = dv.getUint32(12);
  const records = [];
  let o = 16;
  while (o + 24 <= u8.length) {
    const incl = dv.getUint32(o + 4);
    const flags = dv.getUint32(o + 8);
    const ts = dv.getBigInt64(o + 16);
    const data = u8.subarray(o + 24, o + 24 + incl);
    o += 24 + incl;
    records.push({
      received: (flags & 1) === 1,
      isCommandOrEvent: (flags & 2) === 2,
      timeMs: Number((ts - BTSNOOP_EPOCH_DELTA_US) / 1000n),
      data,
      datalink,
    });
  }
  return { datalink, records };
}

/** Extract raw Spark byte fragments from a btsnoop file. */
export function extractSparkFragments(buf) {
  const { datalink, records } = parseBtsnoopRecords(buf);
  const l2cap = new Map(); // `${dir}:${handle}` -> { need, parts }
  const marked = new Set(); // streams identified as Spark
  const prepared = new Map(); // `${dir}:${handle}:${attHandle}` -> bytes[]
  const fragments = [];

  const emit = (rec, transport, streamKey, bytes) => {
    if (!marked.has(streamKey)) {
      if (startsWith(bytes, SIG_TO) || startsWith(bytes, SIG_FROM)) marked.add(streamKey);
      else return;
    }
    fragments.push({
      timeMs: rec.timeMs,
      direction: rec.received ? 'fromAmp' : 'toAmp',
      transport,
      stream: streamKey,
      bytes: Uint8Array.from(bytes),
    });
  };

  for (const rec of records) {
    let pkt = rec.data;
    if (datalink === 1002) {
      if (pkt[0] !== 0x02) continue; // only ACL data
      pkt = pkt.subarray(1);
    } else if (rec.isCommandOrEvent) continue;
    if (pkt.length < 4) continue;

    const hf = pkt[0] | (pkt[1] << 8);
    const handle = hf & 0x0fff;
    const pb = (hf >> 12) & 0x3;
    const payload = pkt.subarray(4, 4 + (pkt[2] | (pkt[3] << 8)));
    const key = `${rec.received ? 'rx' : 'tx'}:${handle}`;

    let frame;
    if (pb === 0x1) {
      const st = l2cap.get(key);
      if (!st) continue;
      st.parts.push(...payload);
      if (st.parts.length < st.need) continue;
      frame = Uint8Array.from(st.parts);
      l2cap.delete(key);
    } else {
      if (payload.length < 4) continue;
      const need = (payload[0] | (payload[1] << 8)) + 4;
      if (payload.length < need) {
        l2cap.set(key, { need, parts: Array.from(payload) });
        continue;
      }
      frame = payload;
    }

    const cid = frame[2] | (frame[3] << 8);
    const body = frame.subarray(4);

    if (cid === 0x0004) {
      // ATT
      const op = body[0];
      const attHandle = body[1] | (body[2] << 8);
      const sk = `ble:${handle}:${attHandle}:${rec.received ? 'rx' : 'tx'}`;
      if (op === 0x12 || op === 0x52 || op === 0x1b || op === 0x1d) {
        emit(rec, 'ble', sk, body.subarray(3));
      } else if (op === 0x16) {
        // prepare write: handle, offset(2), value
        const pk = `${key}:${attHandle}`;
        const arr = prepared.get(pk) || [];
        arr.push(...body.subarray(5));
        prepared.set(pk, arr);
      } else if (op === 0x18 && body[1] === 0x01) {
        // execute write: flush all prepared writes for this connection
        for (const [pk, arr] of prepared) {
          if (!pk.startsWith(`${key}:`)) continue;
          const h = Number(pk.split(':')[2]);
          emit(rec, 'ble', `ble:${handle}:${h}:tx`, arr);
          prepared.delete(pk);
        }
      }
    } else if (cid >= 0x0040) {
      // maybe RFCOMM
      const r = parseRfcomm(body);
      if (!r || r.dlci === 0) continue;
      emit(rec, 'rfcomm', `rfcomm:${handle}:${cid}:${r.dlci}:${rec.received ? 'rx' : 'tx'}`, r.data);
    }
  }
  return fragments;
}

function parseRfcomm(b) {
  if (b.length < 4) return null;
  const addr = b[0];
  if ((addr & 0x01) !== 1) return null; // EA bit must be set
  const control = b[1] & ~0x10; // strip P/F
  if (control !== 0xef) return null; // only UIH frames carry data
  const pf = (b[1] & 0x10) !== 0;
  let o = 2;
  let len = b[o] >> 1;
  if ((b[o] & 0x01) === 0) {
    len |= b[o + 1] << 7;
    o += 2;
  } else o += 1;
  const dlci = addr >> 2;
  if (pf && dlci !== 0) o += 1; // credit byte
  if (o + len > b.length) return null;
  return { dlci, data: b.subarray(o, o + len) };
}

/** Full pipeline: btsnoop bytes -> decoded Spark messages with timestamps. */
export function decodeBtsnoop(buf) {
  const fragments = extractSparkFragments(buf);
  const messages = [];
  const decoders = new Map();
  let t0 = null;
  for (const f of fragments) {
    if (t0 === null) t0 = f.timeMs;
    let d = decoders.get(f.direction);
    if (!d) {
      const dir = f.direction;
      d = new StreamDecoder((m) => {
        messages.push({ timeMs: d.lastTime, t: (d.lastTime - t0) / 1000, direction: dir, seq: m.seq, checksumOk: m.checksumOk, ...decode(m), raw: m.raw });
      });
      decoders.set(f.direction, d);
    }
    d.lastTime = f.timeMs;
    d.push(f.bytes);
  }
  return { fragments, messages };
}

function startsWith(bytes, sig) {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Writer (used by tests and handy for building synthetic captures)
// ---------------------------------------------------------------------------

export function buildBtsnoop(packets) {
  // packets: [{ received, timeMs, h4: Uint8Array }]
  const parts = [];
  const hdr = new Uint8Array(16);
  hdr.set([0x62, 0x74, 0x73, 0x6e, 0x6f, 0x6f, 0x70, 0x00]);
  new DataView(hdr.buffer).setUint32(8, 1);
  new DataView(hdr.buffer).setUint32(12, 1002);
  parts.push(hdr);
  for (const p of packets) {
    const rh = new Uint8Array(24);
    const dv = new DataView(rh.buffer);
    dv.setUint32(0, p.h4.length);
    dv.setUint32(4, p.h4.length);
    dv.setUint32(8, p.received ? 1 : 0);
    dv.setUint32(12, 0);
    dv.setBigInt64(16, BigInt(p.timeMs) * 1000n + BTSNOOP_EPOCH_DELTA_US);
    parts.push(rh, p.h4);
  }
  const len = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of parts) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** Wrap an ATT PDU in L2CAP + ACL + H4. Splits into ACL fragments of aclMax bytes. */
export function attToH4(handle, attPdu, aclMax = 27) {
  const l2 = [attPdu.length & 0xff, attPdu.length >> 8, 0x04, 0x00, ...attPdu];
  const out = [];
  for (let i = 0; i < l2.length; i += aclMax) {
    const frag = l2.slice(i, i + aclMax);
    const pb = i === 0 ? 0x2 : 0x1;
    const hf = (handle & 0x0fff) | (pb << 12);
    out.push(Uint8Array.from([0x02, hf & 0xff, hf >> 8, frag.length & 0xff, frag.length >> 8, ...frag]));
  }
  return out;
}
