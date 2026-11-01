// SparkClient: talks to an amp over any byte transport.
//
// Transport interface:
//   connect(): Promise<{ name?: string }>
//   disconnect(): Promise<void>
//   write(bytes: Uint8Array): Promise<void>   // one encoded block
//   onData = (bytes: Uint8Array) => void      // set by the client
//   onDisconnect = () => void                 // set by the client
//   configure?(modelInfo)                     // optional: per-model write limits
//
// Events (EventTarget, detail = decoded message):
//   'message'  every decoded message from the amp
//   'sent'     every message we send ({ cmd, sub, data, seq, blocks })
//   'preset', 'param', 'effectChanged', 'effectOnOff', 'presetSelected',
//   'presetStored', 'tuner', 'tunerOnOff', 'ampStatus', 'tapTempo', ...  (by decoded type)
//   'connected', 'disconnected', 'error'

import { encodeMessage, StreamDecoder } from './codec.js';
import { CMD, SUB, AMP_MODELS, DEFAULT_MODEL, TEMP_SLOT } from './constants.js';
import * as M from './messages.js';

export class SparkClient extends EventTarget {
  constructor(transport, { timeoutMs = 3000, log = null } = {}) {
    super();
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.seq = 0;
    this.pending = []; // { key, resolve, reject, timer }
    this.queue = Promise.resolve();
    this.info = {};
    this.decoder = new StreamDecoder((m) => this._onMessage(m), {
      onError: (e) => this._emit('error', { error: e }),
    });
    transport.onData = (bytes) => {
      this._emit('rx', { bytes });
      this.decoder.push(bytes);
    };
    transport.onDisconnect = () => {
      this._failAll(new Error('disconnected'));
      this._emit('disconnected', {});
    };
  }

  async connect() {
    const r = await this.transport.connect();
    this.decoder.reset();
    this._emit('connected', r || {});
    return r;
  }

  async disconnect() {
    await this.transport.disconnect();
  }

  /** Standard startup handshake, like the official app (minus the license key). */
  async handshake() {
    const name = await this.ampName();
    const model = AMP_MODELS[name] || DEFAULT_MODEL;
    this.transport.configure?.(model);
    this.info = { name, model };
    this.info.serial = await this.serial().catch(() => null);
    this.info.firmware = await this.firmware().catch(() => null);
    this.info.presetNumber = await this.presetNumber().catch(() => null);
    this.info.status = await this.ampStatus().catch(() => null); // not on Spark 40
    return this.info;
  }

  // ---- requests ------------------------------------------------------------

  async ampName() {
    return (await this.request(M.requestAmpName())).name;
  }
  async serial() {
    return (await this.request(M.requestSerial())).serial;
  }
  async firmware() {
    return (await this.request(M.requestFirmware())).version;
  }
  async presetNumber() {
    return (await this.request(M.requestPresetNumber())).slot;
  }
  async ampStatus() {
    return this.request(M.requestAmpStatus(), { timeoutMs: 1500 });
  }
  async checksums() {
    return (await this.request(M.requestChecksums())).values;
  }
  /** slot: 0..3, 0x7f, or 'current' */
  async getPreset(slot = 'current') {
    return (await this.request(M.requestPreset(slot), { timeoutMs: 5000 })).preset;
  }

  // ---- writes --------------------------------------------------------------

  setParam(effectId, index, value) {
    // 01 04 is not acknowledged by the amp — fire and forget
    return this.send(M.setParam(effectId, index, value));
  }
  changeEffect(oldId, newId) {
    return this.command(M.changeEffect(oldId, newId));
  }
  setEffectOnOff(effectId, on) {
    return this.command(M.setEffectOnOff(effectId, on));
  }
  selectPreset(slot) {
    return this.command(M.selectPreset(slot));
  }
  setTuner(on) {
    return this.command(M.setTuner(on), { optional: true });
  }
  /** Upload a preset (default: temp slot) and make it live. */
  async loadPreset(preset, slot = TEMP_SLOT, { activate = true } = {}) {
    await this.command(M.sendPreset(preset, slot), { timeoutMs: 5000 });
    if (activate) await this.selectPreset(slot);
  }

  // ---- plumbing ------------------------------------------------------------

  nextSeq() {
    this.seq = (this.seq % 0x7f) + 1; // 1..0x7f, never 0xf7-ish values
    return this.seq;
  }

  /** Encode + write without waiting for anything. */
  send(message, seq = this.nextSeq()) {
    const blocks = encodeMessage(message, { seq, direction: 'toAmp' });
    const job = this.queue.then(async () => {
      for (const b of blocks) await this.transport.write(b);
    });
    this.queue = job.catch(() => {});
    this._emit('sent', { ...message, seq, blocks });
    return job;
  }

  /** Send a request (02 xx) and resolve with the decoded 03 xx reply. */
  request(message, { timeoutMs = this.timeoutMs } = {}) {
    const p = this._expect(`${CMD.RESPONSE}:${message.sub}`, timeoutMs);
    this.send(message).catch((e) => this._reject(p, e));
    return p.promise;
  }

  /** Send a write (01 xx) and resolve when acknowledged (04 xx). */
  command(message, { timeoutMs = this.timeoutMs, optional = false } = {}) {
    const p = this._expect(`${CMD.ACK}:${message.sub}`, timeoutMs, optional);
    this.send(message).catch((e) => this._reject(p, e));
    return p.promise;
  }

  /** Send raw, already-encoded bytes (for the reverse-engineering console). */
  async sendRaw(bytes) {
    await this.transport.write(bytes);
    this._emit('sentRaw', { bytes });
  }

  _expect(key, timeoutMs, optional = false) {
    const entry = { key };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.timer = setTimeout(() => {
      this._remove(entry);
      if (optional) entry.resolve(null);
      else entry.reject(new Error(`timeout waiting for ${key}`));
    }, timeoutMs);
    this.pending.push(entry);
    return entry;
  }

  _remove(entry) {
    clearTimeout(entry.timer);
    const i = this.pending.indexOf(entry);
    if (i >= 0) this.pending.splice(i, 1);
  }

  _reject(entry, err) {
    this._remove(entry);
    entry.reject(err);
  }

  _failAll(err) {
    for (const e of [...this.pending]) this._reject(e, err);
  }

  _onMessage(raw) {
    const decoded = { ...M.decode(raw), seq: raw.seq, checksumOk: raw.checksumOk, raw: raw.raw, direction: raw.direction };
    this._emit('message', decoded);

    const key = `${raw.cmd}:${raw.sub}`;
    const waiter = this.pending.find((p) => p.key === key);
    if (waiter) {
      this._remove(waiter);
      waiter.resolve(decoded);
    }
    // 03 xx messages that were not requested are amp-side events (knobs, buttons)
    if (raw.cmd === CMD.RESPONSE || raw.cmd === CMD.WRITE) this._emit(decoded.type, { ...decoded, solicited: !!waiter });
    if (raw.cmd === CMD.RESPONSE && raw.sub === SUB.AMP_NAME) this.info.name = decoded.name;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
