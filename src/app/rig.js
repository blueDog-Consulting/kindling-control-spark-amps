// The rig view: signal-chain strip, amp head and pedalboard.
//
// Rendering is driven by `state.preset.pedals` (chain order). Every parameter
// control registers a setter keyed by "fxIndex:param" so the amp head, the
// pedals and knob moves reported by the amp stay in sync (see syncParam).

import { SLOTS, findEffect, effectsForSlot, paramInfo, basedOn, slotOf, AMP_KNOB_ORDER, SLOT_ORDER } from '../spark/index.js';
import { createKnob, createFootswitch, createToggle, createSelector } from './controls.js';

const SHORT = { gate: 'Gate', comp: 'Comp', drive: 'Drive', amp: 'Amp', mod: 'Mod', delay: 'Delay', reverb: 'Reverb', unknown: 'FX' };

export function createRig({ root, state, actions }) {
  const strip = root.querySelector('.chain-track');
  const tools = root.querySelector('.chain-tools');
  const ampEl = root.querySelector('.amp-head');
  const board = root.querySelector('.pedalboard');
  const controls = new Map();
  const switches = new Map(); // fxIndex -> footswitch/power setter
  let reorder = null; // { order: number[] } while editing the chain order

  const register = (i, p, set) => {
    const k = `${i}:${p}`;
    if (!controls.has(k)) controls.set(k, new Set());
    controls.get(k).add(set);
  };
  const sync = (i, p, v, except) => {
    for (const set of controls.get(`${i}:${p}`) ?? []) if (set !== except) set(v);
  };

  // one throttled sender per parameter, so dragging two knobs doesn't drop either
  const senders = new Map();
  const sendParam = (fx, p, v) => {
    const k = `${fx.name}:${p}`;
    if (!senders.has(k)) senders.set(k, throttle((val) => actions.setParam(fx.name, p, val), 40));
    senders.get(k)(v);
  };

  // ---- parameter controls ----------------------------------------------------

  function paramControl(fx, i, p, slotKey, variant) {
    const info = paramInfo(fx.name, p, slotKey);
    const value = fx.params[p] ?? 0;
    let ctl;
    const onInput = (v) => {
      fx.params[p] = v;
      sync(i, p, v, ctl.set);
      sendParam(fx, p, v);
    };
    if (info.kind === 'switch') ctl = createToggle({ label: info.name, value, onInput });
    else if (info.kind === 'select') ctl = createSelector({ label: info.name, value, options: info.options, onInput });
    else ctl = createKnob({ label: info.name, value, variant, onInput });
    register(i, p, ctl.set);
    return ctl.el;
  }

  function modelSelect(fx, slotKey, className) {
    const sel = document.createElement('select');
    sel.className = className;
    sel.setAttribute('aria-label', `${SHORT[slotKey] ?? 'Effect'} model`);
    const known = findEffect(fx.name);
    const options = effectsForSlot(slotKey);
    if (!known) options.unshift({ id: fx.name, name: `${fx.name} (unknown)` });
    for (const e of options) sel.append(new Option(e.name, e.id, false, e.id.toLowerCase() === fx.name.toLowerCase()));
    sel.addEventListener('change', async () => {
      const ok = await actions.changeEffect(fx.name, sel.value);
      if (!ok) sel.value = fx.name;
    });
    return sel;
  }

  function basedOnLine(fx) {
    const b = basedOn(fx.name);
    return Object.assign(document.createElement('div'), { className: 'based-on', textContent: b ? `Based on ${b}` : '' });
  }

  // ---- amp head ----------------------------------------------------------------

  function renderAmp(fx, i) {
    ampEl.replaceChildren();
    ampEl.hidden = !fx;
    if (!fx) return;
    ampEl.dataset.index = i;
    ampEl.classList.toggle('off', !fx.isOn);

    const panel = document.createElement('div');
    panel.className = 'amp-panel';

    const brand = document.createElement('div');
    brand.className = 'amp-brand';
    brand.append(Object.assign(document.createElement('span'), { className: 'amp-kicker', textContent: 'Amp' }), modelSelect(fx, 'amp', 'amp-model'), basedOnLine(fx));

    const knobs = document.createElement('div');
    knobs.className = 'amp-knobs';
    const count = Math.max(fx.params.length, 5);
    const order = [...AMP_KNOB_ORDER.filter((p) => p < count), ...Array.from({ length: count }, (_, p) => p).filter((p) => !AMP_KNOB_ORDER.includes(p))];
    for (const p of order) knobs.append(paramControl(fx, i, p, 'amp', 'chicken'));

    const power = document.createElement('div');
    power.className = 'amp-power';
    const lamp = Object.assign(document.createElement('span'), { className: 'jewel', title: 'Amp on' });
    const sw = createToggleButton(fx, i, 'Amp');
    power.append(lamp, sw);

    panel.append(brand, knobs, power);
    ampEl.append(panel);
  }

  function createToggleButton(fx, i, name) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'power-switch' });
    b.setAttribute('aria-label', `${name} on`);
    const set = (on) => {
      b.setAttribute('aria-pressed', String(!!on));
      b.textContent = on ? 'ON' : 'OFF';
      ampEl.classList.toggle('off', !on);
    };
    set(fx.isOn);
    b.addEventListener('click', () => {
      fx.isOn = !fx.isOn;
      set(fx.isOn);
      markBlock(i, fx.isOn);
      board.querySelector('.amp-link')?.classList.toggle('off', !fx.isOn);
      actions.setOnOff(fx.name, fx.isOn);
    });
    switches.set(i, set);
    return b;
  }

  // ---- pedals --------------------------------------------------------------------

  function renderPedal(fx, i, slotKey, pos) {
    const known = findEffect(fx.name);
    const el = document.createElement('article');
    el.className = 'pedal';
    el.dataset.slot = slotKey;
    el.dataset.index = i;
    el.classList.toggle('off', !fx.isOn);
    el.setAttribute('aria-label', `${SLOTS.find((s) => s.key === slotKey)?.label ?? 'Effect'}: ${known?.name ?? fx.name}`);

    const top = document.createElement('div');
    top.className = 'pedal-top';
    const led = Object.assign(document.createElement('span'), { className: 'led', title: fx.isOn ? 'On' : 'Off' });
    const pos_ = Object.assign(document.createElement('span'), { className: 'pedal-pos', textContent: String(pos), title: `Position ${pos} in the signal chain` });
    const name = Object.assign(document.createElement('span'), { className: 'pedal-slot', textContent: SLOTS.find((s) => s.key === slotKey)?.label ?? 'Effect' });
    const left = document.createElement('span');
    left.className = 'pedal-top-left';
    left.append(pos_, name);
    top.append(left, led);

    const knobs = document.createElement('div');
    knobs.className = 'pedal-knobs';
    const count = Math.max(fx.params.length, known?.params.length ?? 0);
    for (let p = 0; p < count; p++) knobs.append(paramControl(fx, i, p, slotKey, 'pedal'));

    const plate = document.createElement('div');
    plate.className = 'pedal-plate';
    plate.append(modelSelect(fx, slotKey, 'pedal-model'), basedOnLine(fx));

    const fsw = createFootswitch({
      label: `${known?.name ?? fx.name} on`,
      on: fx.isOn,
      onToggle: (on) => {
        fx.isOn = on;
        el.classList.toggle('off', !on);
        markBlock(i, on);
        actions.setOnOff(fx.name, on);
      },
    });
    switches.set(i, (on) => {
      fsw.set(on);
      el.classList.toggle('off', !on);
    });

    el.append(top, knobs, plate, fsw.el);
    return el;
  }

  // ---- chain strip -----------------------------------------------------------------

  function markBlock(i, on) {
    strip.querySelector(`.chain-block[data-index="${i}"]`)?.classList.toggle('off', !on);
  }

  function renderStrip() {
    const pedals = state.preset?.pedals ?? [];
    const order = reorder?.order ?? pedals.map((_, i) => i);
    strip.replaceChildren(jack('IN'));
    order.forEach((i, pos) => {
      const fx = pedals[i];
      const slotKey = slotOf(fx.name, i);
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chain-block' });
      b.dataset.index = i;
      b.dataset.slot = slotKey;
      b.classList.toggle('off', !fx.isOn);
      b.classList.toggle('dragging', reorder?.dragging === i);
      const name = findEffect(fx.name)?.name ?? fx.name;
      b.setAttribute('aria-label', reorder ? `${SHORT[slotKey]}: ${name}, position ${pos + 1} of ${order.length}. Use left and right arrow keys to move.` : `${SHORT[slotKey]}: ${name}${fx.isOn ? '' : ' (off)'}`);
      b.append(
        Object.assign(document.createElement('span'), { className: 'led' }),
        Object.assign(document.createElement('span'), { className: 'cb-type', textContent: SHORT[slotKey] }),
        Object.assign(document.createElement('span'), { className: 'cb-name', textContent: name }),
      );
      strip.append(b);
    });
    strip.append(jack('OUT'));
    root.classList.toggle('reordering', !!reorder);
    renderTools();
  }

  function jack(text) {
    return Object.assign(document.createElement('span'), { className: 'jack', textContent: text, ariaHidden: 'true' });
  }

  function renderTools() {
    tools.replaceChildren();
    const btn = (label, fn, cls = '') => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: cls });
      b.addEventListener('click', fn);
      tools.append(b);
      return b;
    };
    if (!reorder) {
      btn('Reorder chain', () => {
        reorder = { order: state.preset.pedals.map((_, i) => i) };
        renderStrip();
        strip.querySelector('.chain-block')?.focus();
      }).disabled = !state.preset;
      return;
    }
    tools.append(
      Object.assign(document.createElement('p'), {
        className: 'reorder-hint',
        textContent: 'Drag blocks, or focus one and use ← →. Experimental: the Spark firmware is believed to use a fixed order.',
      }),
    );
    btn('Cancel', () => {
      reorder = null;
      renderStrip();
    });
    btn('Apply', async () => {
      const order = reorder.order;
      reorder = null;
      renderStrip();
      if (order.every((v, k) => v === k)) return;
      await actions.applyOrder(order.map((i) => state.preset.pedals[i]));
    }, 'primary');
  }

  function move(index, to) {
    const order = reorder.order;
    const from = order.indexOf(index);
    if (from < 0 || to < 0 || to >= order.length || to === from) return false;
    order.splice(from, 1);
    order.splice(to, 0, index);
    return true;
  }

  // keyboard reordering
  strip.addEventListener('keydown', (e) => {
    const b = e.target.closest('.chain-block');
    if (!b || !reorder) return;
    const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = Number(b.dataset.index);
    if (move(i, reorder.order.indexOf(i) + d)) {
      renderStrip();
      strip.querySelector(`.chain-block[data-index="${i}"]`)?.focus();
    }
  });

  // click (normal mode): jump to that unit
  strip.addEventListener('click', (e) => {
    const b = e.target.closest('.chain-block');
    if (!b || reorder) return;
    const unit = root.querySelector(`.pedal[data-index="${b.dataset.index}"], .amp-head[data-index="${b.dataset.index}"]`);
    unit?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center', inline: 'nearest' });
    flashEl(unit);
  });

  // pointer dragging (reorder mode). Blocks are re-rendered while dragging,
  // so listen on the document rather than relying on pointer capture.
  strip.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.chain-block');
    if (!b || !reorder || e.button !== 0) return;
    const index = Number(b.dataset.index);
    const startX = e.clientX;
    let dragging = false;
    const onMove = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 4) return;
        dragging = true;
        reorder.dragging = index;
        renderStrip();
      }
      // auto-scroll the track when dragging near its edges (narrow screens)
      const tr = strip.getBoundingClientRect();
      if (ev.clientX < tr.left + 32) strip.scrollLeft -= 14;
      else if (ev.clientX > tr.right - 32) strip.scrollLeft += 14;
      // new position = how many of the other blocks lie left of the pointer
      const others = [...strip.querySelectorAll('.chain-block')].filter((el) => Number(el.dataset.index) !== index);
      const to = others.filter((el) => {
        const r = el.getBoundingClientRect();
        return ev.clientX > r.left + r.width / 2;
      }).length;
      if (move(index, to)) renderStrip();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (reorder) {
        delete reorder.dragging;
        renderStrip();
        strip.querySelector(`.chain-block[data-index="${index}"]`)?.focus();
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });

  // ---- public ------------------------------------------------------------------------

  function render() {
    controls.clear();
    switches.clear();
    reorder = null;
    board.replaceChildren();
    const p = state.preset;
    root.hidden = !p;
    if (!p) {
      renderAmp(null);
      renderStrip();
      return;
    }
    let ampIdx = p.pedals.findIndex((fx, i) => slotOf(fx.name, i) === 'amp');
    if (ampIdx < 0) ampIdx = 3;
    renderAmp(p.pedals[ampIdx], ampIdx);
    // Two rows in signal order: the pedals before the amp, a link showing where
    // the amp sits, then the pedals after it (3 + 3 for a standard chain).
    const row = (stage, title, indices) => {
      const section = document.createElement('section');
      section.className = 'pedal-row';
      section.dataset.stage = stage;
      section.setAttribute('aria-label', title);
      const head = Object.assign(document.createElement('h3'), { className: 'row-title', textContent: title });
      const grid = document.createElement('div');
      grid.className = 'row-pedals';
      for (const i of indices) grid.append(renderPedal(p.pedals[i], i, slotOf(p.pedals[i].name, i), i + 1));
      if (!indices.length) grid.append(Object.assign(document.createElement('p'), { className: 'row-empty', textContent: 'No effects here' }));
      section.append(head, grid);
      return section;
    };
    const all = p.pedals.map((_, i) => i);
    board.append(
      row('pre', 'Into the amp', all.filter((i) => i < ampIdx)),
      ampLink(p.pedals[ampIdx], ampIdx),
      row('post', 'After the amp', all.filter((i) => i > ampIdx)),
    );
    renderStrip();
  }

  /** The bar between the two rows: shows the amp's place in the chain and jumps to the amp head. */
  function ampLink(fx, i) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'amp-link' });
    b.classList.toggle('off', !fx.isOn);
    const name = findEffect(fx.name)?.name ?? fx.name;
    b.setAttribute('aria-label', `Amp, position ${i + 1} in the chain: ${name}. Show amp controls.`);
    const badge = document.createElement('span');
    badge.className = 'amp-link-badge';
    badge.append(
      Object.assign(document.createElement('span'), { className: 'pedal-pos', textContent: String(i + 1) }),
      Object.assign(document.createElement('span'), { className: 'amp-link-kicker', textContent: 'Amp' }),
      Object.assign(document.createElement('span'), { className: 'amp-link-name', textContent: name }),
    );
    b.append(badge);
    b.addEventListener('click', () => {
      ampEl.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      flashEl(ampEl);
    });
    return b;
  }

  function flashEl(el) {
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  return {
    render,
    updateParam: (i, p, v) => sync(i, p, v),
    setOnOff(i, on) {
      switches.get(i)?.(on);
      markBlock(i, on);
      if (ampEl.dataset.index === String(i)) board.querySelector('.amp-link')?.classList.toggle('off', !on);
    },
    flash: (i) => flashEl(root.querySelector(`.pedal[data-index="${i}"], .amp-head[data-index="${i}"]`)),
    isCanonical: (pedals) => pedals.every((fx, i) => SLOT_ORDER[i] === slotOf(fx.name, i)),
  };
}

/** Leading + trailing throttle. */
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
