import {
  SparkClient,
  WebBluetoothTransport,
  CapacitorBleTransport,
  MockSparkTransport,
  SLOTS,
  EFFECTS,
  findEffect,
  effectsForSlot,
  paramInfo,
  decode,
  decodeBtsnoop,
  presetToJson,
  presetFromJson,
  toHex,
  fromHex,
  TEMP_SLOT,
  PRESETS_PER_BANK,
  AMP_KNOB_ORDER,
  blankPreset,
  randomUuid,
} from '../spark/index.js';
import { PresetLibrary } from './library.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const params = new URLSearchParams(location.search);
const useMock = params.has('mock');

const state = {
  client: null,
  connected: false,
  preset: null, // current live state
  slot: null,
  bank: 0, // which bank of four the preset buttons show
  lastIndex: 0, // position (0-3) within the bank of the last hardware preset
  unsaved: false, // live tone came from New and hasn't been saved yet
  library: new PresetLibrary(),
  presetSlots: 4, // 8 on Spark 2
  mock: null,
};

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

function makeTransport() {
  if (useMock) {
    state.mock = new MockSparkTransport({ name: params.get('mock') || 'Spark 40', battery: params.get('mock') !== 'Spark 40' && !!params.get('mock') });
    window.mockAmp = state.mock; // play with it from devtools: mockAmp.turnKnob(3, 0, 0.9)
    return state.mock;
  }
  if (CapacitorBleTransport.isAvailable()) return new CapacitorBleTransport(); // Android / iOS app
  return new WebBluetoothTransport(); // browsers and the Electron desktop app
}

if (!useMock && !CapacitorBleTransport.isAvailable() && !WebBluetoothTransport.isSupported()) $('#unsupported').hidden = false;
if (window.sparkDesktop) setupDesktopDevicePicker(window.sparkDesktop);

$('#connect').addEventListener('click', async () => {
  if (state.connected) {
    await state.client.disconnect();
    return;
  }
  setStatus('busy', 'Connecting…');
  const client = new SparkClient(makeTransport());
  state.client = client;
  wireClient(client);
  try {
    await client.connect();
    setStatus('busy', 'Handshake…');
    const info = await client.handshake();
    state.connected = true;
    showInfo(info);
    setStatus('connected', info.name);
    setConnectedUi(true);
    state.presetSlots = info.model?.presetSlots ?? 4;
    $('.banks').hidden = state.presetSlots <= PRESETS_PER_BANK;
    state.slot = info.presetNumber;
    highlightSlot();
    await refreshPreset();
  } catch (err) {
    console.error(err);
    setStatus('idle', err.name === 'NotFoundError' ? 'Not connected' : 'Connection failed (see Console)');
    logLine('err', `connect failed: ${err.message}`);
    try {
      await client.disconnect();
    } catch {}
  }
});

function wireClient(c) {
  c.addEventListener('disconnected', () => {
    state.connected = false;
    setStatus('idle', 'Disconnected');
    setConnectedUi(false);
  });
  c.addEventListener('message', (e) => logMessage('rx', e.detail));
  c.addEventListener('sent', (e) => logMessage('tx', { ...decode(e.detail), seq: e.detail.seq, raw: e.detail.blocks }));
  c.addEventListener('sentRaw', (e) => logLine('tx', `raw ${toHex(e.detail.bytes)}`));
  c.addEventListener('error', (e) => logLine('err', e.detail.error.message));
  c.addEventListener('log', (e) => logLine('info', `bluetooth: ${e.detail.text}`));

  // amp-side events (knobs and buttons on the amp)
  c.addEventListener('param', (e) => {
    const { effect, index, value, solicited } = e.detail;
    if (solicited || !state.preset) return;
    const i = state.preset.pedals.findIndex((f) => f.name === effect);
    if (i < 0) return;
    state.preset.pedals[i].params[index] = value;
    updateParamUi(i, index, value);
    flash(i);
  });
  c.addEventListener('effectOnOff', (e) => {
    const { effect, on } = e.detail;
    const i = state.preset?.pedals.findIndex((f) => f.name === effect) ?? -1;
    if (i < 0) return;
    state.preset.pedals[i].isOn = on;
    $$('.fx')[i].querySelector('.onoff input').checked = on;
    flash(i);
  });
  c.addEventListener('effectChanged', () => refreshPreset());
  c.addEventListener('presetSelected', (e) => {
    if (e.detail.solicited) return;
    state.slot = e.detail.slot;
    state.unsaved = false; // the amp moved on; the unsaved tone is gone
    highlightSlot();
    refreshPreset();
  });
  c.addEventListener('presetStored', (e) => logLine('rx', `amp stored current state to preset ${e.detail.slot + 1}`));
  c.addEventListener('tuner', (e) => showTuner(e.detail));
  c.addEventListener('tunerOnOff', (e) => ($('#tuner-on').checked = e.detail.on));
  c.addEventListener('ampStatus', (e) => showBattery(e.detail));
}

function setStatus(st, text) {
  const el = $('#status');
  el.dataset.state = st;
  el.textContent = text;
}

function setConnectedUi(on) {
  $('#connect').textContent = on ? 'Disconnect' : 'Connect';
  $('#connect').classList.toggle('primary', !on);
  for (const id of ['#refresh', '#raw-send', '#tuner-on']) $(id).disabled = !on;
  $('#info').hidden = !on;
}

function showInfo(info) {
  $('#i-name').textContent = info.name ?? '–';
  $('#i-fw').textContent = info.firmware ?? '–';
  $('#i-serial').textContent = info.serial ?? '–';
  showBattery(info.status);
}

function showBattery(s) {
  $('#i-batt-wrap').hidden = !s;
  if (!s) return;
  const raw = s.batteryRaw != null ? ` · raw ${s.batteryRaw}` : '';
  $('#i-batt').textContent = `${s.batteryPowered ? 'battery' : 'mains'}, ${s.charging}${raw}`;
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

async function refreshPreset() {
  if (!state.client) return;
  try {
    state.preset = await state.client.getPreset('current');
    renderPreset();
  } catch (err) {
    logLine('err', `could not read current preset: ${err.message}`);
  }
}

$('#refresh').addEventListener('click', refreshPreset);

for (const b of $$('.banks button')) {
  // Switching bank selects the preset in the same position in the new bank
  // (preset 3 in bank 1 -> preset 3 in bank 2).
  b.addEventListener('click', async () => {
    const bank = Number(b.dataset.bank);
    if (!state.connected) {
      state.bank = bank;
      highlightSlot({ followSlot: false });
      return;
    }
    if (bank === state.bank && isHwSlot(state.slot)) return;
    await selectSlot(bank * PRESETS_PER_BANK + state.lastIndex);
  });
}

for (const b of $$('.preset-buttons button')) {
  b.addEventListener('click', async () => {
    if (!state.connected) return;
    await selectSlot(state.bank * PRESETS_PER_BANK + Number(b.dataset.index));
  });
}

async function selectSlot(slot) {
  if (state.unsaved && !confirm('Your new preset is not saved yet. Switch presets anyway?')) return;
  try {
    await state.client.selectPreset(slot);
    state.slot = slot;
    state.unsaved = false;
    highlightSlot();
    await refreshPreset();
  } catch (err) {
    logLine('err', err.message);
  }
}

const isHwSlot = (slot) => Number.isInteger(slot) && slot < state.presetSlots;

/** Sync bank + preset buttons with state.slot. A slot in bank 2 (4-7) switches the view to bank 2. */
function highlightSlot({ followSlot = true } = {}) {
  const isHw = isHwSlot(state.slot);
  if (isHw) state.lastIndex = state.slot % PRESETS_PER_BANK;
  if (followSlot && isHw) state.bank = Math.floor(state.slot / PRESETS_PER_BANK);
  for (const b of $$('.banks button')) b.setAttribute('aria-pressed', String(Number(b.dataset.bank) === state.bank));
  for (const b of $$('.preset-buttons button')) {
    const slot = state.bank * PRESETS_PER_BANK + Number(b.dataset.index);
    b.setAttribute('aria-pressed', String(isHw && slot === state.slot));
    b.setAttribute('aria-label', state.presetSlots > PRESETS_PER_BANK ? `Bank ${state.bank + 1}, preset ${b.dataset.index * 1 + 1}` : `Preset ${b.dataset.index * 1 + 1}`);
  }
}

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${(name || 'preset').replace(/[^\w.-]+/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Latest live tone: ask the amp when connected, otherwise what the UI holds. */
async function liveTone() {
  if (state.connected) {
    try {
      return await state.client.getPreset('current');
    } catch (err) {
      logLine('err', `could not read live tone, using the UI's copy: ${err.message}`);
    }
  }
  return structuredClone(state.preset);
}

async function makeLive(preset) {
  if (state.connected) {
    await state.client.loadPreset(preset, TEMP_SLOT);
    state.slot = TEMP_SLOT;
    highlightSlot();
    await refreshPreset();
  } else {
    state.preset = structuredClone(preset);
    renderPreset();
  }
}

// ---- New ------------------------------------------------------------------

$('#new-preset').addEventListener('click', () => {
  $('#new-name').value = 'New preset';
  $('input[name="new-from"][value="current"]').disabled = !state.preset;
  $(`input[name="new-from"][value="${state.preset ? 'current' : 'blank'}"]`).checked = true;
  $('#new-dialog').showModal();
  $('#new-name').select();
});

$('#new-dialog').addEventListener('close', async () => {
  if ($('#new-dialog').returnValue !== 'ok') return;
  const name = $('#new-name').value.trim() || 'New preset';
  const from = $('input[name="new-from"]:checked').value;
  try {
    const base = from === 'current' && state.preset ? await liveTone() : blankPreset(name);
    const preset = { ...base, name, uuid: randomUuid(), description: from === 'current' ? base.description : '' };
    await makeLive(preset);
    state.unsaved = true;
    renderPresetHeader();
  } catch (err) {
    logLine('err', `could not create preset: ${err.message}`);
    alert(`Could not create preset: ${err.message}`);
  }
});

// ---- Save -----------------------------------------------------------------

function slotLabel(slot) {
  const pos = (slot % PRESETS_PER_BANK) + 1;
  return state.presetSlots > PRESETS_PER_BANK ? `Bank ${Math.floor(slot / PRESETS_PER_BANK) + 1}, preset ${pos}` : `Preset ${pos}`;
}

$('#save-preset').addEventListener('click', () => {
  if (!state.preset) return;
  $('#save-name').value = state.preset.name || '';
  $('#save-desc').value = state.preset.description || '';
  $('#save-library').checked = true;
  const sel = $('#save-slot');
  sel.replaceChildren(new Option("Don't store on the amp", ''));
  if (state.connected) {
    for (let s = 0; s < state.presetSlots; s++) sel.append(new Option(`${slotLabel(s)}${s === state.slot ? ' (current)' : ''}`, String(s)));
    // default: overwrite the slot it came from, if it came from one; else don't store
    sel.value = isHwSlot(state.slot) ? String(state.slot) : '';
  }
  sel.disabled = !state.connected;
  updateSaveWarning();
  $('#save-dialog').showModal();
});

function updateSaveWarning() {
  const v = $('#save-slot').value;
  const w = $('#save-warning');
  w.hidden = v === '';
  if (v !== '') w.textContent = `This replaces what is stored in ${slotLabel(Number(v))} on the amp.`;
}
$('#save-slot').addEventListener('change', updateSaveWarning);

$('#save-dialog').addEventListener('close', async () => {
  if ($('#save-dialog').returnValue !== 'ok') return;
  const toLibrary = $('#save-library').checked;
  const slotValue = $('#save-slot').value;
  if (!toLibrary && slotValue === '') return;
  try {
    const tone = await liveTone();
    const preset = {
      ...tone,
      name: $('#save-name').value.trim() || tone.name || 'Untitled',
      description: $('#save-desc').value.trim(),
      uuid: state.preset.uuid || tone.uuid || randomUuid(),
    };
    if (toLibrary) state.library.save(preset);
    if (slotValue !== '') {
      const slot = Number(slotValue);
      await state.client.storePreset(preset, slot);
      state.slot = slot;
      highlightSlot();
      logLine('info', `stored "${preset.name}" in ${slotLabel(slot)}`);
    }
    state.unsaved = false;
    if (state.connected) await refreshPreset();
    else {
      state.preset = preset;
      renderPreset();
    }
  } catch (err) {
    logLine('err', `save failed: ${err.message}`);
    alert(`Save failed: ${err.message}`);
  }
});

// ---- Library tab ------------------------------------------------------------

function renderLibrary() {
  const items = state.library.list();
  const list = $('#library');
  $('#library-empty').hidden = items.length > 0;
  $('#library-storage-warning').hidden = state.library.persistent;
  list.replaceChildren(
    ...items.map((p) => {
      const li = document.createElement('li');
      li.classList.toggle('active', p.uuid === state.preset?.uuid);
      const name = Object.assign(document.createElement('div'), { className: 'lib-name', textContent: p.name });
      const amp = p.pedals.find((f) => findEffect(f.name)?.slot === 'amp') ?? p.pedals[3];
      const meta = Object.assign(document.createElement('div'), {
        className: 'lib-meta',
        textContent: [p.description, findEffect(amp?.name)?.name ?? amp?.name, p.savedAt ? `saved ${new Date(p.savedAt).toLocaleDateString()}` : ''].filter(Boolean).join(' · '),
      });
      const actions = document.createElement('div');
      actions.className = 'lib-actions';
      const btn = (label, fn, cls = '') => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: cls });
        b.addEventListener('click', fn);
        actions.append(b);
        return b;
      };
      btn('Load', async () => {
        if (state.unsaved && !confirm('Your new preset is not saved yet. Load this one anyway?')) return;
        try {
          await makeLive(state.library.get(p.uuid));
          state.unsaved = false;
          renderPresetHeader();
          selectTab($('#tab-tone'));
        } catch (err) {
          logLine('err', `load failed: ${err.message}`);
        }
      }, 'primary');
      btn('Export', () => download(p.name, presetToJson(state.library.get(p.uuid))));
      btn('Delete', () => {
        if (confirm(`Delete "${p.name}" from My presets? (Presets stored on the amp are not affected.)`)) state.library.remove(p.uuid);
      });
      li.append(name, meta, actions);
      return li;
    }),
  );
}
state.library.addEventListener('change', renderLibrary);
renderLibrary();

$('#import').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let ok = 0;
  for (const file of files) {
    try {
      const preset = presetFromJson(JSON.parse(await file.text()));
      if (!Array.isArray(preset.pedals) || !preset.pedals.length) throw new Error('no effects in file');
      state.library.save({ ...preset, uuid: preset.uuid || randomUuid() });
      ok++;
    } catch (err) {
      logLine('err', `import of ${file.name} failed: ${err.message}`);
      alert(`Could not import ${file.name}: ${err.message}`);
    }
  }
  if (ok) logLine('info', `imported ${ok} preset${ok > 1 ? 's' : ''} into My presets`);
});

$('#export-current').addEventListener('click', async () => {
  if (!state.preset) return;
  download(state.preset.name, presetToJson(await liveTone()));
});

// ---------------------------------------------------------------------------
// signal chain UI
// ---------------------------------------------------------------------------

// Every on-screen control for a parameter registers a setter here, keyed by
// "fxIndex:param", so the amp strip, the effect card and knob moves on the
// amp all stay in sync.
const controls = new Map();
function registerControl(fxIndex, p, setter) {
  const key = `${fxIndex}:${p}`;
  if (!controls.has(key)) controls.set(key, new Set());
  controls.get(key).add(setter);
}
function syncControls(fxIndex, p, value, except) {
  for (const set of controls.get(`${fxIndex}:${p}`) ?? []) if (set !== except) set(value);
}

function renderPreset() {
  const p = state.preset;
  renderPresetHeader();
  controls.clear();
  const chain = $('#chain');
  chain.replaceChildren();
  $('#save-preset').disabled = !p;
  $('#export-current').disabled = !p;
  renderAmpStrip();
  renderLibrary();
  if (!p) return;
  p.pedals.forEach((fx, i) => chain.append(renderFx(fx, i)));
}

function renderPresetHeader() {
  const p = state.preset;
  const name = $('#preset-name');
  name.textContent = p?.name || (p ? 'Untitled' : 'No preset loaded');
  if (p && state.unsaved) name.append(Object.assign(document.createElement('span'), { className: 'unsaved', textContent: 'not saved' }));
  $('#preset-desc').textContent = p ? [p.description, p.bpm ? `${Math.round(p.bpm)} BPM` : ''].filter(Boolean).join(' · ') : '';
}

function ampIndex(p = state.preset) {
  const i = p?.pedals.findIndex((f) => findEffect(f.name)?.slot === 'amp') ?? -1;
  return i >= 0 ? i : 3; // the amp is always the 4th block in the chain
}

/** The amp's main knobs, pinned above the signal chain in top-panel order. */
function renderAmpStrip() {
  const strip = $('#amp-strip');
  const knobs = strip.querySelector('.amp-knobs');
  knobs.replaceChildren();
  const i = ampIndex();
  const amp = state.preset?.pedals[i];
  strip.hidden = !amp;
  if (!amp) return;
  $('#amp-strip-model').textContent = findEffect(amp.name)?.name ?? amp.name;
  for (const p of AMP_KNOB_ORDER) if (p < Math.max(amp.params.length, 5)) knobs.append(renderParam(amp, i, p, amp.params[p] ?? 0, 'amp', 'strip'));
}

function renderFx(fx, i) {
  const card = $('#fx-card').content.firstElementChild.cloneNode(true);
  const known = findEffect(fx.name);
  const slotKey = known?.slot ?? SLOTS[i]?.key;
  card.querySelector('.slot').textContent = SLOTS.find((s) => s.key === slotKey)?.label ?? `Slot ${i + 1}`;

  const onoff = card.querySelector('.onoff input');
  onoff.checked = fx.isOn;
  onoff.setAttribute('aria-label', `${known?.name ?? fx.name} enabled`);
  onoff.addEventListener('change', () => {
    fx.isOn = onoff.checked;
    state.client?.setEffectOnOff(fx.name, onoff.checked).catch((e) => logLine('err', e.message));
  });

  const sel = card.querySelector('.model');
  const options = effectsForSlot(slotKey);
  if (!known) options.unshift({ id: fx.name, name: `${fx.name} (unknown)` });
  for (const e of options) sel.append(new Option(e.name, e.id, false, e.id.toLowerCase() === fx.name.toLowerCase()));
  sel.addEventListener('change', async () => {
    const from = fx.name;
    const to = sel.value;
    try {
      await state.client.changeEffect(from, to);
      await refreshPreset();
    } catch (err) {
      logLine('err', err.message);
      sel.value = from;
    }
  });

  const box = card.querySelector('.params');
  const count = Math.max(fx.params.length, known?.params.length ?? 0);
  for (let p = 0; p < count; p++) box.append(renderParam(fx, i, p, fx.params[p] ?? 0, slotKey));
  return card;
}

function renderParam(fx, fxIndex, p, value, slotKey, idPrefix = 'p') {
  const info = paramInfo(fx.name, p, slotKey);
  const row = document.createElement('div');
  row.className = `param kind-${info.kind}`;
  row.dataset.index = p;
  const id = `${idPrefix}-${fxIndex}-${p}`;
  const label = document.createElement('label');
  label.className = 'name';
  label.htmlFor = id;
  label.textContent = info.name;
  label.title = info.name;
  row.append(label);

  const send = throttle((v) => state.client?.setParam(fx.name, p, v).catch((e) => logLine('err', e.message)), 40);

  if (info.kind === 'switch') {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, className: 'switch', checked: value >= 0.5 });
    input.setAttribute('role', 'switch');
    const set = (v) => (input.checked = v >= 0.5);
    registerControl(fxIndex, p, set);
    input.addEventListener('change', () => {
      fx.params[p] = input.checked ? 1 : 0;
      syncControls(fxIndex, p, fx.params[p], set);
      send(fx.params[p]);
    });
    row.append(input);
  } else if (info.kind === 'select') {
    const input = Object.assign(document.createElement('select'), { id });
    info.options.forEach((o, k) => input.append(new Option(o.label, String(k))));
    const set = (v) => (input.value = String(nearest(info.options, v)));
    set(value);
    registerControl(fxIndex, p, set);
    input.addEventListener('change', () => {
      fx.params[p] = info.options[Number(input.value)].value;
      syncControls(fxIndex, p, fx.params[p], set);
      send(fx.params[p]);
    });
    row.append(input);
  } else {
    const input = Object.assign(document.createElement('input'), { type: 'range', id, min: '0', max: '1', step: '0.005', value: String(value) });
    const out = document.createElement('output');
    out.htmlFor = id;
    const sync = () => {
      const v = Number(input.value);
      input.style.setProperty('--control-value', input.value);
      out.textContent = (v * 10).toFixed(1);
      input.setAttribute('aria-valuetext', `${(v * 10).toFixed(1)} of 10`);
    };
    sync();
    const set = (v) => {
      input.value = String(v);
      sync();
    };
    registerControl(fxIndex, p, set);
    input.addEventListener('input', () => {
      fx.params[p] = Number(input.value);
      sync();
      syncControls(fxIndex, p, fx.params[p], set);
      send(fx.params[p]);
    });
    row.append(input, out);
  }
  return row;
}

function updateParamUi(fxIndex, p, value) {
  syncControls(fxIndex, p, value);
}

function flash(i) {
  const card = $$('.fx')[i];
  if (!card) return;
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 400);
}

function nearest(options, v) {
  let best = 0;
  options.forEach((o, k) => {
    if (Math.abs(o.value - v) < Math.abs(options[best].value - v)) best = k;
  });
  return best;
}

/** Leading + trailing throttle: knob drags send at most one 01 04 per `ms`. */
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending;
  return (v) => {
    pending = v;
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(v);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        fn(pending);
      }, ms - (now - last));
    }
  };
}

// ---------------------------------------------------------------------------
// tuner
// ---------------------------------------------------------------------------

$('#tuner-on').addEventListener('change', (e) => {
  state.client?.setTuner(e.target.checked).catch((err) => logLine('err', err.message));
  if (!e.target.checked) showTuner(null);
});

function showTuner(t) {
  const needle = $('#tuner-needle');
  if (!t) {
    $('#tuner-note').textContent = '–';
    $('#tuner-cents').textContent = '';
    needle.style.insetInlineStart = '';
    return;
  }
  // offset is 0..1 with 0.5 = in tune (≈ ±50 cents range)
  const cents = Math.round((t.offset - 0.5) * 100);
  $('#tuner-note').textContent = t.noteName;
  $('#tuner-cents').textContent = `${cents > 0 ? '+' : ''}${cents} cents`;
  needle.style.insetInlineStart = `calc(${Math.min(1, Math.max(0, t.offset)) * 100}% - 0.175rem)`;
  needle.classList.toggle('in-tune', Math.abs(cents) <= 3);
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

const NOISY = new Set(['param', 'tuner']);

function logMessage(dir, m) {
  if ($('#hide-params').checked && NOISY.has(m.type)) return;
  const li = document.createElement('li');
  li.className = `${dir}${m.type === 'unknown' || m.type === 'unparsed' ? ' unknown' : ''}`;
  li.append(formatMessage(dir, m));
  appendLog($('#log'), li);
}

function formatMessage(dir, m) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const arrow = dir === 'tx' ? '→' : '←';
  const fields = { ...m };
  for (const k of ['cmd', 'sub', 'key', 'type', 'raw', 'seq', 'checksumOk', 'direction', 'timeMs', 't', 'solicited']) delete fields[k];
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${m.t != null ? `${m.t.toFixed(3)}s ` : ''}${arrow} [${m.key}] #${(m.seq ?? 0).toString(16)} `;
  summary.append(meta, `${m.type}${m.checksumOk === false ? ' (BAD CHECKSUM)' : ''} ${summarize(fields)}`);
  details.append(summary);
  const pre = document.createElement('code');
  pre.className = 'hex';
  pre.textContent = (m.raw ?? []).map((b) => toHex(b)).join('\n');
  details.append(pre);
  return details;
}

function summarize(fields) {
  if (fields.preset) {
    const p = fields.preset;
    return `"${p.name}" slot=${p.current ? 'current' : p.slot} ${p.pedals.map((f) => (f.isOn ? f.name : `(${f.name})`)).join(' → ')}`;
  }
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v}`)
    .join(' ');
}

function logLine(cls, text) {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  appendLog($('#log'), li);
}

function appendLog(list, li) {
  list.prepend(li);
  while (list.children.length > 500) list.lastElementChild.remove();
}

$('#clear-log').addEventListener('click', () => $('#log').replaceChildren());

$('#raw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.connected) return;
  const text = $('#raw-input').value.trim();
  try {
    const bytes = fromHex(text);
    if (bytes[0] === 0x01 && bytes[1] === 0xfe) await state.client.sendRaw(bytes);
    else if (bytes.length >= 2) await state.client.send({ cmd: bytes[0], sub: bytes[1], data: bytes.subarray(2) });
    else throw new Error('need at least cmd and sub bytes');
  } catch (err) {
    logLine('err', err.message);
  }
});

// ---------------------------------------------------------------------------
// capture decoder
// ---------------------------------------------------------------------------

let captureMessages = [];

$('#capture-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { fragments, messages } = decodeBtsnoop(new Uint8Array(await file.arrayBuffer()));
    captureMessages = messages;
    const kinds = [...new Set(fragments.map((f) => f.transport))].join(', ') || 'none';
    const unknown = messages.filter((m) => m.type === 'unknown' || m.type === 'unparsed').length;
    $('#capture-summary').textContent = fragments.length
      ? `${messages.length} Spark messages (${unknown} not yet understood) from ${fragments.length} fragments over ${kinds}.`
      : 'No Spark traffic found in this capture. Was the official app connected while logging?';
    renderCapture();
  } catch (err) {
    $('#capture-summary').textContent = `Could not read capture: ${err.message}`;
  }
});
$('#capture-unknown').addEventListener('change', renderCapture);

function renderCapture() {
  const only = $('#capture-unknown').checked;
  const list = $('#capture-log');
  list.replaceChildren();
  for (const m of captureMessages) {
    if (only && m.type !== 'unknown' && m.type !== 'unparsed') continue;
    const li = document.createElement('li');
    const dir = m.direction === 'toAmp' ? 'tx' : 'rx';
    li.className = `${dir}${m.type === 'unknown' || m.type === 'unparsed' ? ' unknown' : ''}`;
    li.append(formatMessage(dir, m));
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// tabs (roving tabindex, arrow-key navigation)
// ---------------------------------------------------------------------------

const tabs = $$('[role="tab"]');
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const next = tabs[(i + d + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
});

// ---------------------------------------------------------------------------
// Electron: Chromium has no built-in Bluetooth chooser there, so the main
// process forwards the scan results and we show our own picker.
// ---------------------------------------------------------------------------

function setupDesktopDevicePicker(desktop) {
  const dialog = $('#bt-picker');
  const list = $('#bt-list');
  let open = false;
  const choose = (id) => {
    desktop.selectBluetoothDevice(id);
    open = false;
    dialog.close();
  };
  desktop.onBluetoothDevices((devices) => {
    if (!open) {
      open = true;
      dialog.showModal();
    }
    list.replaceChildren(
      ...devices.map((d) => {
        const li = document.createElement('li');
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: d.name || d.id });
        b.addEventListener('click', () => choose(d.id));
        li.append(b);
        return li;
      }),
    );
    $('#bt-scanning').hidden = devices.length > 0;
  });
  $('#bt-cancel').addEventListener('click', () => choose(''));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    choose('');
  });
}

if (useMock) setStatus('idle', 'Simulated amp');
// expose for poking around in devtools
window.spark = { state, EFFECTS };
