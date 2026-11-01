// "My presets": presets saved on this device, independent of the amp's
// hardware slots. Stored in localStorage as Ignitron-compatible preset JSON,
// so the same objects can be exported and imported as files.
//
// Storage can be unavailable (private windows, blocked site data); every
// access is guarded and the library then works in memory for the session.

import { presetToJson, presetFromJson } from '../spark/messages.js';

const KEY = 'kindling-control.presets.v1';
// Earlier versions of the app (as "Spark Control") stored presets here; migrated on first load.
const LEGACY_KEYS = ['spark-control.presets.v1'];

export class PresetLibrary extends EventTarget {
  constructor(storage = safeStorage()) {
    super();
    this.storage = storage;
    this.items = this._load();
  }

  /** All presets, most recently saved first. */
  list() {
    return [...this.items].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).map((i) => ({ ...presetFromJson(i.json), savedAt: i.savedAt }));
  }

  get(uuid) {
    const i = this.items.find((x) => x.json.UUID === uuid);
    return i ? presetFromJson(i.json) : null;
  }

  /** Add or replace (by UUID). */
  save(preset) {
    if (!preset.uuid) throw new Error('preset needs a uuid');
    const json = presetToJson({ ...preset, slot: null });
    delete json.PresetNumber;
    const entry = { json, savedAt: Date.now() };
    const i = this.items.findIndex((x) => x.json.UUID === preset.uuid);
    if (i >= 0) this.items[i] = entry;
    else this.items.push(entry);
    this._persist();
  }

  remove(uuid) {
    this.items = this.items.filter((x) => x.json.UUID !== uuid);
    this._persist();
  }

  get persistent() {
    return !!this.storage;
  }

  _load() {
    try {
      this._migrateLegacy();
      const raw = this.storage?.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => x?.json?.UUID && Array.isArray(x.json.Pedals)) : [];
    } catch {
      return [];
    }
  }

  _migrateLegacy() {
    if (!this.storage || this.storage.getItem(KEY) !== null) return;
    for (const old of LEGACY_KEYS) {
      const raw = this.storage.getItem(old);
      if (raw === null) continue;
      this.storage.setItem(KEY, raw);
      this.storage.removeItem(old);
      return;
    }
  }

  _persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.items));
    } catch {
      // quota exceeded or storage blocked: keep working in memory
    }
    this.dispatchEvent(new Event('change'));
  }
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__spark_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
