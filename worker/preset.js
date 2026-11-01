// Validates an uploaded preset file and turns it into the normalised form we store.
// Accepts one preset as exported by KindlingControl's Presets tab (Ignitron-compatible JSON).
// Nothing from the upload is stored verbatim: every field is checked and re-serialised.

import { presetToJson } from '../src/spark/messages.js';
import { findEffect, slotOf } from '../src/spark/effects.js';
import { HttpError, cleanText } from './util.js';

export const MAX_UPLOAD_BYTES = 32 * 1024;
const EFFECT_ID = /^[A-Za-z0-9 ._+()-]{1,64}$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

const bad = (message) => new HttpError(400, message);

/** @returns {{ preset: object, name: string, amp: string, chain: {name: string, slot: string, on: boolean}[] }} */
export function normalisePreset(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bad('Upload one preset file, exported from the Presets tab in KindlingControl.');
  }
  const name = cleanText(input.Name, 64);
  if (!name) throw bad('The preset has no name.');
  if (!Array.isArray(input.Pedals) || input.Pedals.length !== 7) throw bad('A preset needs exactly 7 effect blocks.');

  const pedals = input.Pedals.map((fx, i) => {
    const id = typeof fx?.Name === 'string' ? fx.Name.trim() : '';
    if (!EFFECT_ID.test(id)) throw bad(`Block ${i + 1} has a missing or invalid effect name.`);
    if (!Array.isArray(fx.Parameters) || fx.Parameters.length > 32) throw bad(`Block ${i + 1} has invalid parameters.`);
    const params = fx.Parameters.map(Number);
    if (!params.every((v) => Number.isFinite(v) && Math.abs(v) <= 100)) throw bad(`Block ${i + 1} has an out-of-range parameter.`);
    return { name: id, isOn: fx.IsOn === true, params };
  });

  const bpm = Number(input.BPM);
  const preset = presetToJson({
    slot: null,
    uuid: typeof input.UUID === 'string' && UUID.test(input.UUID) ? input.UUID.toUpperCase() : crypto.randomUUID().toUpperCase(),
    name,
    version: cleanText(input.Version, 16) || '0.7',
    description: cleanText(input.Description, 200),
    icon: 'icon.png',
    bpm: Number.isFinite(bpm) && bpm >= 20 && bpm <= 400 ? bpm : 120,
    pedals,
  });
  delete preset.PresetNumber; // not tied to an amp slot

  const chain = pedals.map((fx, i) => ({ name: findEffect(fx.name)?.name ?? fx.name, slot: slotOf(fx.name, i), on: fx.isOn }));
  const amp = chain.find((c) => c.slot === 'amp')?.name ?? '';
  return { preset, name, amp, chain };
}
