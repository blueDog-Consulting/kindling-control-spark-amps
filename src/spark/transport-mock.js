// A simulated Spark amp. Speaks the real wire protocol (it decodes what the
// client writes and answers with properly framed amp->app blocks, split into
// random BLE-sized fragments), so it exercises the whole stack without
// hardware. Use it via ?mock in the web UI, or in tests.

import { encodeMessage, StreamDecoder, MsgWriter } from './codec.js';
import { CMD, SUB, TEMP_SLOT } from './constants.js';
import { decode, presetWriter, randomUuid } from './messages.js';
import { findEffect, canonicalOrder } from './effects.js';

const P = (name, desc, pedals) => ({ uuid: randomUuid(), name, version: '0.7', description: desc, icon: 'icon.png', bpm: 120, pedals });
const fx = (name, isOn, params) => ({ name, isOn, params });

export function demoPresets(count = 4) {
  const base = [
    P('Silver Clean', '1-Clean', [
      fx('bias.noisegate', true, [0.2, 0.3, 0]),
      fx('LA2AComp', true, [0, 0.6, 0.3]),
      fx('Booster', false, [0.5]),
      fx('RolandJC120', true, [0.35, 0.55, 0.5, 0.45, 0.6]),
      fx('ChorusAnalog', true, [0.4, 0.3, 0.5, 0.5]),
      fx('DelayMono', false, [0.2, 0.3, 0.5, 0.6, 1]),
      fx('bias.reverb', true, [0.4, 0.5, 0.5, 0.5, 0.2, 0.6, 0.3]),
    ]),
    P('Crunch Plexi', '2-Crunch', [
      fx('bias.noisegate', true, [0.3, 0.3, 0]),
      fx('BlueComp', false, [0.5, 0.5, 0.5, 0.5]),
      fx('DistortionTS9', true, [0.3, 0.5, 0.7]),
      fx('Plexi', true, [0.65, 0.6, 0.55, 0.5, 0.55]),
      fx('Phaser', false, [0.4, 0.5]),
      fx('VintageDelay', true, [0.3, 0.3, 0.3, 1]),
      fx('bias.reverb', true, [0.3, 0.5, 0.5, 0.4, 0.2, 0.6, 0.0]),
    ]),
    P('Treadplate Lead', '3-Lead', [
      fx('bias.noisegate', true, [0.5, 0.3, 0]),
      fx('Compressor', true, [0.5, 0.5]),
      fx('KlonCentaurSilver', true, [0.6, 0.5, 0.2]),
      fx('Rectifier', true, [0.8, 0.6, 0.4, 0.6, 0.5]),
      fx('Flanger', false, [0.4, 0.5, 0.5]),
      fx('DelayMono', true, [0.25, 0.35, 0.45, 0.6, 1]),
      fx('bias.reverb', true, [0.25, 0.5, 0.5, 0.5, 0.2, 0.6, 0.7]),
    ]),
    P('Acoustic Sim', '4-Acoustic', [
      fx('bias.noisegate', false, [0.1, 0.3, 0]),
      fx('BBEOpticalComp', true, [0.5, 0.4, 0]),
      fx('Booster', false, [0.4]),
      fx('Acoustic', true, [0.4, 0.5, 0.5, 0.5, 0.6]),
      fx('GuitarEQ6', false, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      fx('DelayEchoFilt', false, [0.3, 0.3, 0.3, 0.5, 1]),
      fx('bias.reverb', true, [0.5, 0.5, 0.5, 0.6, 0.2, 0.6, 0.4]),
    ]),
  ];
  // Spark 2: a second bank of four, variations of the first
  const bank2 = base.map((p, i) => ({ ...clone(p), uuid: randomUuid(), name: `${p.name} B`, description: `${i + 5}-Bank 2` }));
  return [...base, ...bank2].slice(0, count);
}

export class MockSparkTransport {
  constructor({ name = 'Spark 40', latencyMs = 15, battery = true, fixedChain = true, busyPresets = false, dropFirstRequests = 0 } = {}) {
    // Simulates an amp that isn't listening yet: the first N requests get no reply.
    this.dropRequests = dropFirstRequests;
    this.ampName = name;
    // With busyPresets the mock ignores a preset request that arrives while it is still
    // answering the previous one: one model of an amp that can't overlap multi-chunk
    // transfers (unverified on real hardware; see docs/PROTOCOL.md).
    this.busyPresets = busyPresets;
    this.presetBusy = false;
    // Real firmware is believed to use fixed slots; with fixedChain the mock
    // stores uploaded presets in canonical order, like an amp that ignores reordering.
    this.fixedChain = fixedChain;
    this.latencyMs = latencyMs;
    this.battery = battery;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.presets = demoPresets(/spark 2/i.test(name) ? 8 : 4);
    this.tempPreset = null;
    this.slot = 0;
    this.current = clone(this.presets[0]);
    this.seq = 0;
    this.connected = false;
    this.decoder = new StreamDecoder((m) => this._handle(m));
  }

  async connect() {
    await sleep(this.latencyMs);
    this.connected = true;
    return { name: `${this.ampName} BLE (simulated)` };
  }

  async disconnect() {
    this.connected = false;
    clearInterval(this.tunerTimer);
    this.onDisconnect();
  }

  async write(bytes) {
    if (!this.connected) throw new Error('not connected');
    this.decoder.push(bytes);
  }

  // ---- simulate physical controls --------------------------------------------

  /** Pretend someone turned a knob on the amp. */
  turnKnob(slotIndex, paramIndex, value) {
    const fx = this.current.pedals[slotIndex];
    fx.params[paramIndex] = value;
    this._emitEvent(SUB.PARAM_CHANGED, new MsgWriter().prefixedStr(fx.name).byte(paramIndex).float(value).byte(0));
  }

  /** Pretend someone pressed a preset button on the amp. */
  pressPreset(slot) {
    this.slot = slot;
    this.current = clone(this.presets[slot]);
    this._emitEvent(SUB.CHANGE_PRESET, new MsgWriter().byte(0).byte(slot));
  }

  // ---- protocol handling ------------------------------------------------------

  _handle(m) {
    const { cmd, sub, seq } = m;
    if (cmd === CMD.REQUEST) {
      if (this.dropRequests > 0) {
        this.dropRequests--;
        return;
      }
      return this._request(sub, m, seq);
    }
    if (cmd === CMD.WRITE) return this._write(sub, m, seq);
  }

  _request(sub, m, seq) {
    const w = new MsgWriter();
    switch (sub) {
      case SUB.AMP_NAME:
        w.prefixedStr(this.ampName);
        break;
      case SUB.SERIAL:
        w.prefixedStr('S40SIM0000001');
        break;
      case SUB.FIRMWARE:
        w.byte(0xce).raw([1, 9, 7, 60]);
        break;
      case SUB.PRESET_NUMBER:
        w.byte(0).byte(this.slot);
        break;
      case SUB.CHECKSUMS:
        w.arrayHeader(4).raw([0x11, 0x22, 0x33, 0x44]);
        break;
      case SUB.AMP_STATUS:
        if (!this.battery) return; // Spark 40 doesn't answer
        w.byte(0x0a).byte(1).byte(1).byte(0).int16(3900).int16(1651).byte(0x20);
        break;
      case SUB.PRESET: {
        const [hi, lo] = m.data;
        const isCurrent = hi === 0x01;
        const p = isCurrent ? this.current : lo === TEMP_SLOT ? this.tempPreset : this.presets[lo];
        if (!p) return;
        if (this.busyPresets && this.presetBusy) return; // dropped: still sending the last one
        const pw = presetWriter(p, lo, { current: isCurrent });
        this.presetBusy = true;
        return this._reply(CMD.RESPONSE, SUB.PRESET, pw.toBytes(), seq, () => (this.presetBusy = false));
      }
      default:
        return; // unknown request: real amps stay silent too
    }
    this._reply(CMD.RESPONSE, sub, w.toBytes(), seq);
  }

  _write(sub, m, seq) {
    const d = decode(m);
    switch (sub) {
      case SUB.PARAM: {
        const fx = this.current.pedals.find((f) => f.name === d.effect);
        if (fx) fx.params[d.index] = d.value;
        return; // no ack for 01 04
      }
      case SUB.CHANGE_EFFECT: {
        const fx = this.current.pedals.find((f) => f.name === d.from);
        if (fx) {
          fx.name = d.to;
          const n = findEffect(d.to)?.params.length || fx.params.length;
          fx.params = Array.from({ length: n }, () => 0.5);
        }
        break;
      }
      case SUB.EFFECT_ONOFF: {
        const fx = this.current.pedals.find((f) => f.name === d.effect);
        if (fx) fx.isOn = d.on;
        break;
      }
      case SUB.CHANGE_PRESET:
        this.slot = d.slot;
        this.current = clone(d.slot === TEMP_SLOT ? this.tempPreset : this.presets[d.slot]);
        break;
      case SUB.PRESET: {
        const p = d.preset;
        if (this.fixedChain) p.pedals = canonicalOrder(p.pedals);
        if (p.slot === TEMP_SLOT) this.tempPreset = p;
        else this.presets[p.slot] = p;
        break;
      }
      case SUB.TUNER_ONOFF:
        clearInterval(this.tunerTimer);
        if (d.on) {
          let t = 0;
          this.tunerTimer = setInterval(() => {
            t += 1;
            const offset = 0.5 + 0.3 * Math.sin(t / 4);
            this._emitEvent(SUB.TUNER_OUTPUT, new MsgWriter().byte(4).float(offset)); // E
          }, 150);
        }
        break;
      default:
        break;
    }
    this._reply(CMD.ACK, sub, new Uint8Array(0), seq);
  }

  _emitEvent(sub, w) {
    this.seq = (this.seq % 0x7f) + 1;
    this._reply(CMD.RESPONSE, sub, w.toBytes(), this.seq);
  }

  _reply(cmd, sub, data, seq, done = () => {}) {
    const blocks = encodeMessage({ cmd, sub, data }, { seq, direction: 'fromAmp' });
    const stream = blocks.flatMap((b) => Array.from(b));
    // deliver in BLE-notification-sized fragments of random length
    setTimeout(() => {
      let i = 0;
      while (i < stream.length) {
        const n = 10 + Math.floor(Math.random() * 40);
        if (this.connected) this.onData(Uint8Array.from(stream.slice(i, i + n)));
        i += n;
      }
      done();
    }, this.latencyMs);
  }
}

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
