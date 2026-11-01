// Low-level Spark wire codec: msgpack-ish value writer/reader, 7-bit packing,
// chunk + block framing. Pure functions, no I/O — works in browsers and Node.

import {
  BLOCK_MAGIC,
  BLOCK_HEADER_LEN,
  DIR_TO_AMP,
  DIR_FROM_AMP,
  CHUNK_END,
  LIMITS,
} from './constants.js';

// ---------------------------------------------------------------------------
// Value writer (8-bit payload, before 7-bit packing)
// ---------------------------------------------------------------------------

export class MsgWriter {
  constructor() {
    this.bytes = [];
  }

  byte(b) {
    this.bytes.push(b & 0xff);
    return this;
  }

  raw(arr) {
    for (const b of arr) this.byte(b);
    return this;
  }

  /** msgpack unsigned int, smallest encoding. */
  int(n) {
    if (n < 0) {
      if (n >= -32) return this.byte(n & 0xff); // negative fixint
      return this.byte(0xd0).byte(n & 0xff); // int8
    }
    if (n <= 0x7f) return this.byte(n);
    if (n <= 0xff) return this.byte(0xcc).byte(n);
    if (n <= 0xffff) return this.byte(0xcd).byte(n >> 8).byte(n);
    return this.byte(0xce).byte(n >>> 24).byte(n >>> 16).byte(n >>> 8).byte(n);
  }

  int16(n) {
    return this.byte(0xcd).byte(n >> 8).byte(n);
  }

  bool(v) {
    return this.byte(v ? 0xc3 : 0xc2);
  }

  arrayHeader(n) {
    if (n > 15) throw new RangeError('fixarray only supports up to 15 entries');
    return this.byte(0x90 + n);
  }

  /** fixstr (<=31 chars) or str8 for longer strings. */
  str(s) {
    const b = asciiBytes(s);
    if (b.length <= 31) this.byte(0xa0 + b.length);
    else this.byte(0xd9).byte(b.length);
    return this.raw(b);
  }

  /** str8 (0xd9) regardless of length — used for preset UUIDs. */
  longStr(s) {
    const b = asciiBytes(s);
    return this.byte(0xd9).byte(b.length).raw(b);
  }

  /**
   * "Prefixed" string used for effect names in 01 04 / 01 06 / 01 15:
   * a fixint holding the length, followed by a normal fixstr.
   */
  prefixedStr(s) {
    const b = asciiBytes(s);
    return this.byte(b.length).byte(0xa0 + b.length).raw(b);
  }

  /** float32, big-endian. Values are written bit-exact (presets are checksummed). */
  float(v) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    return this.byte(0xca).raw(new Uint8Array(dv.buffer));
  }

  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Value reader
// ---------------------------------------------------------------------------

export class MsgReader {
  constructor(bytes) {
    this.b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.pos = 0;
  }

  get remaining() {
    return this.b.length - this.pos;
  }

  peek(offset = 0) {
    return this.b[this.pos + offset];
  }

  byte() {
    if (this.pos >= this.b.length) throw new RangeError('read past end of message');
    return this.b[this.pos++];
  }

  int() {
    const t = this.byte();
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    switch (t) {
      case 0xcc:
        return this.byte();
      case 0xcd:
        return (this.byte() << 8) | this.byte();
      case 0xce:
        return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
      case 0xd0: {
        const v = this.byte();
        return v > 0x7f ? v - 0x100 : v;
      }
      case 0xd1: {
        const v = (this.byte() << 8) | this.byte();
        return v > 0x7fff ? v - 0x10000 : v;
      }
      default:
        throw new TypeError(`expected int, got 0x${hex(t)} at ${this.pos - 1}`);
    }
  }

  bool() {
    const t = this.byte();
    if (t === 0xc3) return true;
    if (t === 0xc2) return false;
    throw new TypeError(`expected bool, got 0x${hex(t)} at ${this.pos - 1}`);
  }

  arrayHeader() {
    const t = this.byte();
    if (t >= 0x90 && t <= 0x9f) return t - 0x90;
    if (t === 0xdc) return (this.byte() << 8) | this.byte();
    throw new TypeError(`expected array, got 0x${hex(t)} at ${this.pos - 1}`);
  }

  /** Reads fixstr, str8, or a "prefixed" string (fixint length + fixstr). */
  str() {
    let t = this.byte();
    let len;
    if (t === 0xd9) len = this.byte();
    else if (t >= 0xa0 && t <= 0xbf) len = t - 0xa0;
    else if (t <= 0x7f && this.peek() === 0xa0 + t) {
      this.byte();
      len = t;
    } else if (t <= 0x7f && this.peek() === 0xd9) {
      // prefixed long string
      this.byte();
      len = this.byte();
    } else throw new TypeError(`expected string, got 0x${hex(t)} at ${this.pos - 1}`);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.byte());
    return s;
  }

  float() {
    const t = this.byte();
    if (t === 0xca) {
      const dv = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4);
      this.pos += 4;
      return dv.getFloat32(0);
    }
    // Some firmware sends whole numbers as ints in float slots.
    this.pos--;
    return this.int();
  }

  /** Generic msgpack decode of one value (best effort, for the debug console). */
  any() {
    const t = this.peek();
    if (t === undefined) throw new RangeError('read past end of message');
    if (t <= 0x7f || t >= 0xe0 || [0xcc, 0xcd, 0xce, 0xd0, 0xd1].includes(t)) {
      // could be a prefixed string
      if (t <= 0x7f && this.peek(1) === 0xa0 + t && t > 0) return this.str();
      return this.int();
    }
    if (t === 0xc2 || t === 0xc3) return this.bool();
    if (t === 0xca) return this.float();
    if ((t >= 0xa0 && t <= 0xbf) || t === 0xd9) return this.str();
    if ((t >= 0x90 && t <= 0x9f) || t === 0xdc) {
      const n = this.arrayHeader();
      const arr = [];
      for (let i = 0; i < n && this.remaining > 0; i++) arr.push(this.any());
      return arr;
    }
    if (t === 0xc0) {
      this.byte();
      return null;
    }
    this.byte();
    return { unknown: t };
  }

  /** Decode everything left as a list of generic values. */
  all() {
    const out = [];
    while (this.remaining > 0) {
      try {
        out.push(this.any());
      } catch {
        out.push({ raw: toHex(this.b.subarray(this.pos)) });
        break;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 7-bit packing ("8th bits" byte followed by up to 7 data bytes)
// ---------------------------------------------------------------------------

export function pack7(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const group = bytes.slice(i, i + 7);
    let bits8 = 0;
    for (let j = 0; j < group.length; j++) if (group[j] & 0x80) bits8 |= 1 << j;
    out.push(bits8);
    for (const b of group) out.push(b & 0x7f);
  }
  return Uint8Array.from(out);
}

export function unpack7(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 8) {
    const bits8 = bytes[i];
    for (let j = 0; j < 7 && i + 1 + j < bytes.length; j++) {
      const b = bytes[i + 1 + j];
      out.push(bits8 & (1 << j) ? b | 0x80 : b);
    }
  }
  return Uint8Array.from(out);
}

export function xor(bytes) {
  let c = 0;
  for (const b of bytes) c ^= b;
  return c;
}

/** Presets carry a trailing checksum: sum of bytes (excluding slot) mod 256. */
export function presetChecksum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xff;
  return s;
}

export function isMultiChunk(cmd, sub) {
  return (cmd === 0x01 || cmd === 0x03) && sub === 0x01;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Encode a message into one or more blocks ready to write to the transport.
 * @param {object} msg { cmd, sub, data: Uint8Array (8-bit) }
 * @param {object} opts { seq, direction: 'toAmp'|'fromAmp', header: bool }
 * @returns {Uint8Array[]} blocks
 */
export function encodeMessage({ cmd, sub, data = new Uint8Array(0) }, opts = {}) {
  const { seq = 1, direction = 'toAmp', header = true } = opts;
  if (seq < 0 || seq > 0x7f) throw new RangeError('seq must be 0..0x7f');
  const lim = LIMITS[direction];
  const multi = isMultiChunk(cmd, sub);

  // 1. split 8-bit payload into chunks (+ sub-header for multi-chunk messages)
  const parts = [];
  const n = Math.max(1, Math.ceil(data.length / lim.chunk));
  for (let i = 0; i < n; i++) {
    const slice = Array.from(data.subarray(i * lim.chunk, (i + 1) * lim.chunk));
    parts.push(multi ? [n, i, slice.length, ...slice] : slice);
  }

  // 2. 7-bit pack and wrap each chunk in F0 01 ... F7
  const stream = [];
  for (const p of parts) {
    const packed = pack7(p);
    stream.push(0xf0, 0x01, seq, xor(packed), cmd, sub, ...packed, CHUNK_END);
  }

  // 3. split chunk stream into blocks
  if (!header) return [Uint8Array.from(stream)];
  const dir = direction === 'toAmp' ? DIR_TO_AMP : DIR_FROM_AMP;
  const room = lim.block - BLOCK_HEADER_LEN;
  const blocks = [];
  for (let i = 0; i < stream.length; i += room) {
    const body = stream.slice(i, i + room);
    blocks.push(
      Uint8Array.from([...BLOCK_MAGIC, ...dir, BLOCK_HEADER_LEN + body.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...body]),
    );
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Streaming decoder
// ---------------------------------------------------------------------------

/**
 * Incremental decoder. Feed it raw bytes in whatever fragments the transport
 * delivers (BLE notifications, RFCOMM frames, ...). It strips block headers
 * wherever they occur (chunks may span blocks), extracts F0 01 ... F7 chunks,
 * unpacks 7-bit data and merges multi-chunk messages.
 *
 * onMessage({ cmd, sub, seq, data, direction, checksumOk, raw })
 */
export class StreamDecoder {
  constructor(onMessage, { onError } = {}) {
    this.onMessage = onMessage;
    this.onError = onError || (() => {});
    this.buf = [];
    this.chunk = null; // bytes of the chunk in progress
    this.direction = null;
    this.multi = new Map(); // key cmd:sub -> { parts, seq }
  }

  reset() {
    this.buf = [];
    this.chunk = null;
    this.multi.clear();
  }

  push(bytes) {
    for (const b of bytes) this.buf.push(b);
    this._drain();
  }

  _drain() {
    const buf = this.buf;
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      // block header? 0x01 0xFE can never appear inside 7-bit chunk data
      if (b === 0x01) {
        if (i + 1 >= buf.length) break; // need more data to decide
        if (buf[i + 1] === 0xfe) {
          if (i + BLOCK_HEADER_LEN > buf.length) break; // wait for full header
          const d0 = buf[i + 4];
          if (d0 === 0x41) this.direction = 'fromAmp';
          else if (d0 === 0x53) this.direction = 'toAmp';
          i += BLOCK_HEADER_LEN;
          continue;
        }
      }
      if (this.chunk === null) {
        if (b === 0xf0) {
          if (i + 1 >= buf.length) break;
          if (buf[i + 1] === 0x01) {
            this.chunk = [0xf0, 0x01];
            i += 2;
            continue;
          }
        }
        i++; // garbage between chunks — skip
        continue;
      }
      if (this.chunk.length < 6) {
        // seq / checksum / cmd / sub are raw bytes, not 7-bit packed
        this.chunk.push(b);
        i++;
        continue;
      }
      if (b === CHUNK_END) {
        this.chunk.push(b);
        this._chunk(this.chunk);
        this.chunk = null;
        i++;
        continue;
      }
      if (b & 0x80 && b !== 0xf0) {
        // not valid inside a chunk — resync
        this.onError(new Error(`unexpected 0x${hex(b)} inside chunk, resyncing`));
        this.chunk = null;
        continue;
      }
      if (b === 0xf0) {
        this.onError(new Error('chunk start inside chunk, resyncing'));
        this.chunk = null;
        continue;
      }
      this.chunk.push(b);
      i++;
    }
    this.buf = buf.slice(i);
  }

  _chunk(c) {
    if (c.length < 7) return this.onError(new Error('chunk too short'));
    const seq = c[2];
    const sum = c[3];
    const cmd = c[4];
    const sub = c[5];
    const packed = c.slice(6, -1);
    const checksumOk = xor(packed) === sum;
    if (!checksumOk) this.onError(new Error(`checksum mismatch on ${hex(cmd)} ${hex(sub)}`));
    const data = unpack7(packed);
    const raw = Uint8Array.from(c);

    if (isMultiChunk(cmd, sub) && data.length >= 3) {
      const [total, index] = data;
      const key = `${cmd}:${sub}`;
      let m = this.multi.get(key);
      if (!m || index === 0) {
        m = { parts: [], seq, raw: [] };
        this.multi.set(key, m);
      }
      m.parts[index] = data.subarray(3);
      m.raw.push(raw);
      if (index === total - 1) {
        this.multi.delete(key);
        const missing = m.parts.length !== total || m.parts.some((p) => !p);
        const merged = concat(m.parts.filter(Boolean));
        this.onMessage({ cmd, sub, seq, data: merged, direction: this.direction, checksumOk: checksumOk && !missing, raw: m.raw });
      }
      return;
    }
    this.onMessage({ cmd, sub, seq, data, direction: this.direction, checksumOk, raw: [raw] });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function concat(arrays) {
  const len = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export function hex(n) {
  return n.toString(16).padStart(2, '0');
}

export function toHex(bytes, sep = ' ') {
  return Array.from(bytes, hex).join(sep);
}

export function fromHex(str) {
  const clean = str.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error('odd number of hex digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
