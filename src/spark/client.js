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
import { CMD, SUB, TEMP_SLOT, modelSettings } from './constants.js';
import * as M from './messages.js';
import { defaultParams } from './effects.js';

export class SparkClient extends EventTarget {
  constructor(transport, { timeoutMs = 3000, log = null } = {}) {
    super();
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.seq = 0;
    this.pending = []; // { key, resolve, reject, timer }
    this.queue = Promise.resolve();
    this.inFlight = new Map(); // reply key -> promise of the request currently waiting for it
    this.info = {};
    this.decoder = new StreamDecoder((m) => this._onMessage(m), {
      onError: (e) => this._emit('error', { error: e }),
    });
    transport.onData = (bytes) => {
      this._emit('rx', { bytes });
      this.decoder.push(bytes);
    };
    transport.onLog = (text) => this._emit('log', { text });
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
    const model = modelSettings(name);
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
  changeEffect(oldId, newId, opts) {
    return this.command(M.changeEffect(oldId, newId), opts);
  }

  /**
   * Swap the model in a slot and confirm it took, by reading the live preset back.
   * Tries the dedicated swap message (01 06) first. If the amp doesn't
   * acknowledge it, or acknowledges it but keeps the old model, the edited
   * preset is loaded into the temporary slot instead (nothing stored changes).
   * Resolves with { method: 'swap' | 'preset', preset } where preset is the
   * amp's live preset afterwards; rejects if neither way worked.
   */
  async swapEffect(oldId, newId) {
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    const has = (p, id) => p.pedals.some((f) => same(f.name, id));
    let swapError = null;
    try {
      // the ack normally takes milliseconds; don't keep the user waiting long before falling back
      await this.changeEffect(oldId, newId, { timeoutMs: Math.min(this.timeoutMs, 1500) });
    } catch (err) {
      if (err.code !== 'ETIMEDOUT') throw err;
      swapError = err;
    }
    const live = await this.getPreset('current');
    if (!swapError && has(live, newId)) return { method: 'swap', preset: live };
    this._emit('log', { text: `amp ${swapError ? 'did not acknowledge' : 'ignored'} 01 06 swap ${oldId} -> ${newId}; loading the edited preset into the temporary slot` });

    const i = live.pedals.findIndex((f) => same(f.name, oldId));
    if (i < 0) {
      if (has(live, newId)) return { method: 'swap', preset: live }; // took after all
      throw new Error(`${oldId} isn't in the amp's current preset`);
    }
    const edited = structuredClone(live);
    const old = live.pedals[i];
    edited.pedals[i] = { name: newId, isOn: old.isOn, params: defaultParams(newId, old.params.length) };
    await this.loadPreset(edited, TEMP_SLOT);
    const after = await this.getPreset('current');
    if (!has(after, newId)) throw new Error(`the amp didn't accept ${newId}`);
    return { method: 'preset', preset: after };
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
  /**
   * Store a preset in a hardware slot (0-3, or 0-7 on Spark 2), replacing what
   * was there, and switch the amp to it.
   */
  async storePreset(preset, slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= TEMP_SLOT) throw new RangeError(`bad hardware slot ${slot}`);
    await this.command(M.sendPreset(preset, slot), { timeoutMs: 5000 });
    await this.selectPreset(slot);
  }

  /**
   * Experimental: try a preset whose pedals are in a non-standard order. It is
   * loaded into the temporary slot (nothing stored changes) and read back. If
   * the amp normalises the order, accepted is false.
   * Note: accepted only means the amp *kept* the order; whether the DSP
   * processes it in that order has to be confirmed by ear.
   */
  async tryChainOrder(preset) {
    await this.loadPreset(preset, TEMP_SLOT);
    const readBack = await this.getPreset('current');
    const names = (p) => p.pedals.map((f) => f.name.toLowerCase()).join('|');
    return { accepted: names(readBack) === names(preset), preset: readBack };
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
    return this._oneAtATime(`${CMD.RESPONSE}:${message.sub}`, timeoutMs, false, message);
  }

  /** Send a write (01 xx) and resolve when acknowledged (04 xx). */
  command(message, { timeoutMs = this.timeoutMs, optional = false } = {}) {
    return this._oneAtATime(`${CMD.ACK}:${message.sub}`, timeoutMs, optional, message);
  }

  /**
   * Replies are matched only by cmd:sub, so two requests waiting for the same reply type
   * can't tell their answers apart, and an amp busy with one multi-chunk preset transfer
   * may not answer an overlapping request at all ("timeout waiting for 3:1", issue #9).
   * So at most one request per reply key is outstanding: the next one is sent once the
   * previous one has settled, and its timeout starts only then.
   */
  _oneAtATime(key, timeoutMs, optional, message) {
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run = previous.then(() => {
      const p = this._expect(key, timeoutMs, optional);
      this.send(message).catch((e) => this._reject(p, e));
      return p.promise;
    });
    const settled = run.catch(() => {});
    this.inFlight.set(key, settled);
    settled.then(() => {
      if (this.inFlight.get(key) === settled) this.inFlight.delete(key);
    });
    return run;
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
      else entry.reject(Object.assign(new Error(`timeout waiting for ${key}`), { code: 'ETIMEDOUT' }));
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
