// Presets hub pages on kindlingspark.app. Plain DOM, no dependencies.
// Every piece of user content is written with textContent, never as HTML.

const SLOT_LABELS = { gate: 'Gate', comp: 'Comp', drive: 'Drive', amp: 'Amp', mod: 'Mod', delay: 'Delay', reverb: 'Reverb' };
const $ = (sel) => document.querySelector(sel);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

const date = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const setStatus = (text, kind = '') => {
  const s = $('#status');
  s.textContent = text;
  s.dataset.kind = kind;
  s.hidden = !text;
};

function chainStrip(chain) {
  return el(
    'ol',
    { class: 'chain-mini', 'aria-label': 'Signal chain' },
    ...chain.map((c) =>
      el('li', { class: `slot-${c.slot}${c.on ? '' : ' off'}`, title: `${SLOT_LABELS[c.slot] ?? c.slot}: ${c.name}${c.on ? '' : ' (off)'}` }, el('span', { text: c.name })),
    ),
  );
}

// ---------------------------------------------------------------- browse

async function browse() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') ?? '', sort: params.get('sort') === 'popular' ? 'popular' : 'new', amp: params.get('amp') ?? '', page: 1 };
  $('#q').value = state.q;
  $('#sort').value = state.sort;

  async function load(append = false) {
    const qs = new URLSearchParams({ sort: state.sort, page: String(state.page) });
    if (state.q) qs.set('q', state.q);
    if (state.amp) qs.set('amp', state.amp);
    history.replaceState(null, '', `?${new URLSearchParams(Object.entries({ q: state.q, sort: state.sort === 'new' ? '' : state.sort, amp: state.amp }).filter(([, v]) => v))}`);
    $('#amp-filter').hidden = !state.amp;
    $('#amp-name').textContent = state.amp;
    setStatus(append ? '' : 'Loading presets…');
    try {
      const data = await api(`/presets?${qs}`);
      if (!append) $('#results').replaceChildren();
      for (const p of data.items) $('#results').append(card(p));
      $('#more').hidden = !data.hasMore;
      const count = $('#results').children.length;
      setStatus(count ? '' : state.q || state.amp ? 'No presets match. Try a different search.' : 'No presets shared yet. Be the first!');
    } catch (err) {
      setStatus(`Couldn't load presets: ${err.message}`, 'error');
    }
  }

  function card(p) {
    const link = `/presets/preset.html?id=${encodeURIComponent(p.id)}`;
    return el(
      'li',
      { class: 'preset-card' },
      el('h2', {}, el('a', { href: link, text: p.name })),
      el(
        'p',
        { class: 'meta' },
        p.amp ? el('button', { type: 'button', class: 'chip', text: p.amp, title: `Show presets using ${p.amp}`, onclick: () => filterAmp(p.amp) }) : null,
        el('span', { text: ` by ${p.author} · ${date(p.createdAt)} · ${plural(p.downloads, 'download')}` }),
      ),
      p.description ? el('p', { class: 'desc', text: p.description }) : null,
      chainStrip(p.chain),
      el('p', { class: 'card-actions' }, el('a', { class: 'btn btn-small', href: `/api/presets/${encodeURIComponent(p.id)}/download`, download: '', text: 'Download' }), el('a', { href: link, text: 'Details' })),
    );
  }

  function filterAmp(amp) {
    Object.assign(state, { amp, page: 1 });
    load();
  }

  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(state, { q: $('#q').value.trim(), sort: $('#sort').value, page: 1 });
    load();
  });
  $('#sort').addEventListener('change', () => $('#search').requestSubmit());
  $('#amp-clear').addEventListener('click', () => filterAmp(''));
  $('#more').addEventListener('click', () => {
    state.page++;
    load(true);
  });
  load();
}

// ---------------------------------------------------------------- detail

async function detail() {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  let p;
  try {
    p = await api(`/presets/${encodeURIComponent(id)}`);
  } catch (err) {
    setStatus(err.status === 404 ? "That preset isn't here any more. It may have been deleted." : `Couldn't load the preset: ${err.message}`, 'error');
    return;
  }
  document.title = `${p.name} · KindlingControl presets`;
  $('#name').textContent = p.name;
  $('#meta').textContent = `${p.amp ? `${p.amp} · ` : ''}shared by ${p.author} on ${date(p.createdAt)} · ${plural(p.downloads, 'download')}`;
  $('#desc').textContent = p.description;
  $('#desc').hidden = !p.description;
  $('#chain').replaceChildren(
    ...p.chain.map((c, i) =>
      el('li', { class: `slot-${c.slot}${c.on ? '' : ' off'}` }, el('span', { class: 'slot', text: `${i + 1}. ${SLOT_LABELS[c.slot] ?? c.slot}` }), el('strong', { text: c.name }), el('span', { class: 'state', text: c.on ? 'On' : 'Off' })),
    ),
  );
  $('#download').href = `/api/presets/${encodeURIComponent(p.id)}/download`;
  $('#hidden-note').hidden = !p.hidden;
  $('#manage').hidden = !p.canManage;
  $('#restore').hidden = !(p.isAdmin && p.hidden);
  $('#detail').hidden = false;
  setStatus('');

  $('#delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${p.name}" for everyone? This can't be undone.`)) return;
    try {
      await api(`/presets/${encodeURIComponent(p.id)}`, { method: 'DELETE', body: {} });
      location.href = '/presets/';
    } catch (err) {
      alert(err.message);
    }
  });
  $('#restore').addEventListener('click', async () => {
    try {
      await api(`/presets/${encodeURIComponent(p.id)}/restore`, { method: 'POST', body: {} });
      location.reload();
    } catch (err) {
      alert(err.message);
    }
  });
  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/presets/${encodeURIComponent(p.id)}/report`, { method: 'POST', body: { reason: $('#reason').value } });
      $('#report-form').replaceChildren(el('p', { text: 'Thanks. A moderator will take a look.' }));
    } catch (err) {
      alert(err.message);
    }
  });
}

// ---------------------------------------------------------------- share

async function share() {
  let me;
  try {
    ({ user: me } = await api('/me'));
  } catch (err) {
    setStatus(`Couldn't reach the presets hub: ${err.message}`, 'error');
    return;
  }
  setStatus('');
  if (!me) return signedOut();

  $('#signed-in').hidden = false;
  $('#me-email').textContent = me.email;
  $('#display-name').value = me.displayName;
  $('#signout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    location.reload();
  });

  $('#name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/me', { method: 'PATCH', body: { displayName: $('#display-name').value } });
      $('#display-name').value = r.displayName;
      setStatus('Display name saved.', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });

  let parsed = null;
  $('#file').addEventListener('change', async () => {
    parsed = null;
    const file = $('#file').files[0];
    $('#preview').hidden = true;
    if (!file) return;
    try {
      if (file.size > 32 * 1024) throw new Error('That file is too large to be a preset.');
      parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.Pedals)) throw new Error("That doesn't look like a preset file.");
      $('#preview').textContent = `Preset: ${parsed.Name || '(no name)'}, ${plural(parsed.Pedals.length, 'effect block')}`;
      $('#preview').dataset.kind = '';
    } catch (err) {
      parsed = null;
      $('#preview').textContent = err instanceof SyntaxError ? "That file isn't valid JSON." : err.message;
      $('#preview').dataset.kind = 'error';
    }
    $('#preview').hidden = false;
  });

  $('#upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!parsed) {
      setStatus('Choose a preset file exported from KindlingControl first.', 'error');
      return;
    }
    const button = e.submitter;
    button.disabled = true;
    try {
      const r = await api('/presets', { method: 'POST', body: { preset: parsed, description: $('#description').value, license: $('#license').checked } });
      location.href = `/presets/preset.html?id=${encodeURIComponent(r.id)}`;
    } catch (err) {
      setStatus(err.message, 'error');
      button.disabled = false;
    }
  });

  const mine = await api('/me/presets').catch(() => ({ items: [] }));
  if (mine.items.length) $('#mine').replaceChildren(...mine.items.map((p) => myRow(p)));

  if (me.isAdmin) {
    $('#moderation').hidden = false;
    const hidden = await api('/admin/hidden').catch(() => ({ items: [] }));
    $('#hidden-list').replaceChildren(
      ...(hidden.items.length
        ? hidden.items.map((p) =>
            el(
              'li',
              {},
              el('a', { href: `/presets/preset.html?id=${encodeURIComponent(p.id)}`, text: p.name }),
              el('span', { class: 'muted', text: ` by ${p.author} · ${plural(p.reports, 'report')}${p.reasons ? `: ${p.reasons}` : ''}` }),
            ),
          )
        : [el('li', { class: 'muted', text: 'Nothing hidden.' })]),
    );
  }
}

function myRow(p) {
  return el(
    'li',
    {},
    el('a', { href: `/presets/preset.html?id=${encodeURIComponent(p.id)}`, text: p.name }),
    el('span', { class: 'muted', text: ` · ${date(p.createdAt)} · ${plural(p.downloads, 'download')}${p.hidden ? ' · hidden after reports' : ''}` }),
  );
}

function signedOut() {
  $('#signed-out').hidden = false;
  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      const r = await api('/auth/request', { method: 'POST', body: { email: $('#email').value } });
      $('#signin-sent').hidden = false;
      if (r.devLink) {
        // Local development only (DEV_SHOW_LINKS=1): no email is sent, so show the link.
        $('#dev-link').replaceChildren('Development mode: ', el('a', { href: r.devLink, text: 'open the sign-in link' }));
        $('#dev-link').hidden = false;
      }
      setStatus('');
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- finish sign-in

function signin() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname); // keep the token out of history and screenshots
  if (!token) {
    $('#signin-text').textContent = 'This page needs the link from your sign-in email.';
    $('#finish').replaceWith(el('a', { class: 'btn', href: '/presets/share.html', text: 'Get a sign-in link' }));
    return;
  }
  $('#finish').addEventListener('click', async () => {
    $('#finish').disabled = true;
    setStatus('Signing in…');
    try {
      await api('/auth/verify', { method: 'POST', body: { token } });
      location.href = '/presets/share.html';
    } catch (err) {
      setStatus(err.message, 'error');
      $('#finish').replaceWith(el('a', { class: 'btn', href: '/presets/share.html', text: 'Get a new sign-in link' }));
    }
  });
}

({ browse, detail, share, signin })[document.body.dataset.page]?.();
