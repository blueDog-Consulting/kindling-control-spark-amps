// High-level message builders (app -> amp) and parsers (amp -> app / app -> amp).
// Builders return { cmd, sub, data } — framing and sequence numbers are added
// by codec.encodeMessage / SparkClient.

import { MsgWriter, MsgReader, presetChecksum, toHex } from './codec.js';
import { CMD, SUB, TEMP_SLOT, NOTE_NAMES } from './constants.js';

const msg = (cmd, sub, w = new MsgWriter()) => ({ cmd, sub, data: w.toBytes() });
const req = (sub, w) => msg(CMD.REQUEST, sub, w);
const write = (sub, w) => msg(CMD.WRITE, sub, w);

// ---------------------------------------------------------------------------
// Requests (02 xx). The amp answers with 03 xx.
// ---------------------------------------------------------------------------

export const requestAmpName = () => req(SUB.AMP_NAME);
export const requestSerial = () => req(SUB.SERIAL);
export const requestFirmware = () => req(SUB.FIRMWARE);
export const requestPresetNumber = () => req(SUB.PRESET_NUMBER);
export const requestAmpStatus = () => req(SUB.AMP_STATUS);
export const requestChecksums = () => req(SUB.CHECKSUMS, new MsgWriter().arrayHeader(4).raw([0, 1, 2, 3]));
export const requestLooperStatus = () => req(SUB.LOOPER_STATUS);

/**
 * Request a preset.
 * @param {number|'current'} slot 0..3 hardware slot, 0x7f temp slot, or 'current' for the live state
 */
export function requestPreset(slot = 'current') {
  const w = new MsgWriter();
  if (slot === 'current') w.byte(0x01).byte(0x00);
  else w.byte(0x00).byte(slot);
  return req(SUB.PRESET, w);
}

// ---------------------------------------------------------------------------
// Writes (01 xx). Most are acknowledged with 04 xx (01 04 is not).
// ---------------------------------------------------------------------------

/**
 * Change a parameter of an effect in the live state. value: 0..1
 * The trailing input byte (0 = Input 1, 1 = Input 2) is in the spec (v3.4); the
 * Spark 2 silently ignores 01 04 without it.
 */
export function setParam(effectId, index, value, input = 0) {
  return write(SUB.PARAM, new MsgWriter().prefixedStr(effectId).byte(index).float(value).byte(input));
}

/** Swap the model in a slot: e.g. ('Twin', 'Plexi'). */
export function changeEffect(oldId, newId) {
  return write(SUB.CHANGE_EFFECT, new MsgWriter().prefixedStr(oldId).prefixedStr(newId));
}

export function setEffectOnOff(effectId, on) {
  // trailing 0x00 matches what the official app sends (seen by Ignitron)
  return write(SUB.EFFECT_ONOFF, new MsgWriter().prefixedStr(effectId).bool(on).byte(0x00));
}

/** Activate a hardware preset (0..3) or the temp slot (0x7f). */
export function selectPreset(slot) {
  return write(SUB.CHANGE_PRESET, new MsgWriter().byte(0x00).byte(slot));
}

export function setTuner(on) {
  return write(SUB.TUNER_ONOFF, new MsgWriter().bool(on));
}

/** Ask the amp to report expression/wah volume (only meaningful for JH.Vox846). */
export function setAmpInfo(effectId, on) {
  return write(SUB.AMP_INFO, new MsgWriter().prefixedStr(effectId).bool(on));
}

/**
 * Upload a full preset. By default it goes to the temp slot (0x7f), which
 * does not overwrite anything stored on the amp; follow with selectPreset(0x7f)
 * to make it live. Slots 0..3 overwrite the stored hardware preset.
 */
export function sendPreset(preset, slot = TEMP_SLOT) {
  return write(SUB.PRESET, presetWriter(preset, slot));
}

export function presetWriter(p, slot = TEMP_SLOT, { current = false } = {}) {
  const w = new MsgWriter();
  if (current) w.byte(0x01).byte(0x00);
  else w.byte(0x00).byte(slot);
  const start = w.bytes.length;
  w.longStr(p.uuid || randomUuid());
  w.str(p.name ?? 'Untitled');
  w.str(p.version ?? '0.7');
  w.str(p.description ?? '');
  w.str(p.icon ?? 'icon.png');
  w.float(p.bpm ?? 120);
  w.arrayHeader(p.pedals.length);
  for (const fx of p.pedals) {
    w.str(fx.name);
    w.bool(!!fx.isOn);
    w.arrayHeader(fx.params.length);
    fx.params.forEach((v, i) => {
      w.byte(i).arrayHeader(1).float(v);
    });
  }
  w.byte(presetChecksum(w.bytes.slice(start)));
  return w;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a preset payload (01 01 or 03 01 after multi-chunk merge).
 * Returns { slot, current, uuid, name, version, description, icon, bpm, pedals: [{ name, isOn, params: [] }] }
 */
export function parsePreset(data) {
  const r = new MsgReader(data);
  const hi = r.byte();
  const lo = r.byte();
  const p = { current: hi === 0x01, slot: hi === 0x01 ? null : lo };
  p.uuid = r.str();
  p.name = r.str();
  p.version = r.str();
  p.description = r.str();
  p.icon = r.str();
  p.bpm = r.float();
  const n = r.arrayHeader();
  p.pedals = [];
  for (let i = 0; i < n; i++) {
    const fx = { name: r.str(), isOn: r.bool(), params: [] };
    const np = r.arrayHeader();
    for (let j = 0; j < np; j++) {
      const idx = r.int();
      const inner = r.arrayHeader(); // always 1
      let v = 0;
      for (let k = 0; k < inner; k++) v = r.float();
      fx.params[idx] = v;
    }
    p.pedals.push(fx);
  }
  if (r.remaining > 0) {
    p.checksum = r.byte();
    p.checksumOk = p.checksum === presetChecksum(data.subarray(2, data.length - 1));
  }
  return p;
}


/**
 * Decode any message into { type, ...fields }. Unknown messages come back as
 * { type: 'unknown', values } with a best-effort generic msgpack decode so you
 * can reverse-engineer them from the console.
 */
export function decode({ cmd, sub, data }) {
  const r = new MsgReader(data);
  const base = { cmd, sub, key: `${hex2(cmd)} ${hex2(sub)}` };
  try {
    if (cmd === CMD.ACK || cmd === CMD.ACK_PARTIAL) {
      return { ...base, type: 'ack', final: cmd === CMD.ACK, of: subName(sub), values: r.all() };
    }
    if (cmd === CMD.REQUEST) {
      return { ...base, type: 'request', what: subName(sub), values: r.all() };
    }
    if (cmd === CMD.WRITE || cmd === CMD.RESPONSE) {
      const fromAmp = cmd === CMD.RESPONSE;
      switch (sub) {
        case SUB.PRESET:
          return { ...base, type: 'preset', preset: parsePreset(data) };
        case SUB.PARAM:
        case SUB.PARAM_CHANGED: {
          const m = { ...base, type: 'param', effect: r.str(), index: r.int(), value: r.float() };
          if (r.remaining > 0) m.input = r.int(); // trailing input byte (missing in older captures)
          return m;
        }
        case SUB.CHANGE_EFFECT:
          return { ...base, type: 'effectChanged', from: r.str(), to: r.str() };
        case SUB.EFFECT_ONOFF:
          return { ...base, type: 'effectOnOff', effect: r.str(), on: r.bool() };
        case SUB.PRESET_NUMBER:
        case SUB.CHANGE_PRESET: {
          r.byte();
          return { ...base, type: 'presetSelected', slot: r.int() };
        }
        case SUB.STORE_PRESET: {
          r.byte();
          return { ...base, type: 'presetStored', slot: r.int() };
        }
        case SUB.AMP_NAME:
          return { ...base, type: 'ampName', name: r.str() };
        case SUB.SERIAL: {
          // serial number string seems to include a trailing junk character
          const s = r.str();
          return { ...base, type: 'serial', serial: s.replace(/[^\x20-\x7e]+$/, '').replace(/\xf7$/, '') };
        }
        case SUB.FIRMWARE: {
          const t = r.peek();
          if (t === 0xce) {
            r.byte();
            const v = [r.byte(), r.byte(), r.byte(), r.byte()];
            return { ...base, type: 'firmware', version: v.join('.') };
          }
          return { ...base, type: 'firmware', version: String(r.any()) };
        }
        case SUB.CHECKSUMS:
        case SUB.CHECKSUMS_EXT: {
          return { ...base, type: 'checksums', values: r.all() };
        }
        case SUB.AMP_INFO:
          return fromAmp
            ? { ...base, type: 'ampInfo', value: r.float() }
            : { ...base, type: 'ampInfoEnable', effect: r.str(), on: r.bool() };
        case SUB.TAP_TEMPO:
          return { ...base, type: 'tapTempo', bpm: r.float() };
        case SUB.TUNER_OUTPUT: {
          const note = r.int();
          const offset = r.float();
          return { ...base, type: 'tuner', note, noteName: NOTE_NAMES[note % 12] ?? '?', offset };
        }
        case SUB.TUNER_ONOFF:
          return { ...base, type: 'tunerOnOff', on: r.bool() };
        case SUB.INPUT_VOLUME:
          return { ...base, type: 'inputVolume', value: r.float() };
        case SUB.AMP_STATUS:
          return { ...base, type: 'ampStatus', ...parseAmpStatus(r) };
        case SUB.LICENSE:
          return { ...base, type: 'license', values: r.all() };
        default:
          return { ...base, type: 'unknown', values: r.all() };
      }
    }
    return { ...base, type: 'unknown', values: r.all() };
  } catch (err) {
    return { ...base, type: 'unparsed', error: err.message, hex: toHex(data) };
  }
}

const CHARGING = ['discharging', 'powered', 'charging', 'full'];

function parseAmpStatus(r) {
  const values = r.all();
  // Layout observed by Ignitron: [?, 1, batteryPowered, chargingStatus, batteryLevel, ?, ?]
  const [, , powered, charging, level] = values;
  return {
    batteryPowered: powered === 1,
    charging: CHARGING[charging] ?? `unknown(${charging})`,
    batteryRaw: typeof level === 'number' ? level : null,
    values,
  };
}

export function subName(sub) {
  for (const [k, v] of Object.entries(SUB)) if (v === sub) return k;
  return `0x${hex2(sub)}`;
}

function hex2(n) {
  return n.toString(16).padStart(2, '0');
}

export function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toUpperCase();
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => (c === 'x' ? h() : '89ab'[Math.floor(Math.random() * 4)])).toUpperCase();
}

// ---------------------------------------------------------------------------
// Preset JSON (compatible with Ignitron's data/*.json files)
// ---------------------------------------------------------------------------

export function presetToJson(p) {
  return {
    PresetNumber: p.slot ?? TEMP_SLOT,
    UUID: p.uuid,
    Name: p.name,
    Version: p.version,
    Description: p.description,
    Icon: p.icon,
    BPM: p.bpm,
    Pedals: p.pedals.map((fx) => ({ Name: fx.name, IsOn: fx.isOn, Parameters: fx.params })),
  };
}

export function presetFromJson(j) {
  return {
    slot: j.PresetNumber ?? TEMP_SLOT,
    uuid: j.UUID,
    name: j.Name,
    version: j.Version ?? '0.7',
    description: j.Description ?? '',
    icon: j.Icon ?? 'icon.png',
    bpm: j.BPM ?? 120,
    pedals: (j.Pedals ?? []).map((fx) => ({ name: fx.Name, isOn: !!fx.IsOn, params: fx.Parameters.map(Number) })),
  };
}
