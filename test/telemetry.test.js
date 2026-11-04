import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrub,
  detectApp,
  buildReport,
  sanitizeReport,
  createReporter,
  fingerprint,
  PREF_KEY,
  scrubLog,
  buildLog,
  sanitizeLog,
  LOG_LIMITS,
  LOG_ENDPOINT,
  ENDPOINT,
} from '../src/app/telemetry.js';
import { handle } from '../telemetry/worker.js';
import { stamp } from '../tools/stamp-version.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('scrub removes identifying text', () => {
  const cases = [
    ['stored "Jeremy\'s Blues" in Preset 1', 'stored "…" in Preset 1'],
    ["import of 'my rig.json' failed", "import of '…' failed"],
    ['mail jeremy@example.com now', 'mail <email> now'],
    ['at f (/Users/jeremy/app/x.js:1:2)', 'at f (/Users/~/app/x.js:1:2)'],
    ['at f (C:\\Users\\Jeremy\\app\\x.js:1:2)', 'at f (C:\\Users\\~\\app\\x.js:1:2)'],
    ['at f (kindling://app/app/app.js:12:3)', 'at f (/app/app.js:12:3)'],
    ['GET https://example.com/a/b?token=secret#x failed', 'GET /a/b failed'],
    ['device 3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'device <id>'],
    ['mac AA:BB:CC:DD:EE:FF', 'mac <id>'],
    ['id pW1qX5vH3c+2y3m0HxQ8Rw== gone', 'id <id> gone'],
    ['serial S999C12345678', 'serial <id>'],
    ['bytes 01 fe 00 00 53 fe 1a 00 00 00 00 00', 'bytes <hex>'],
    ['big 1234567', 'big <n>'],
  ];
  for (const [input, want] of cases) assert.equal(scrub(input), want, input);
});

test('scrub keeps ordinary error text and apostrophes', () => {
  assert.equal(scrub("Couldn't connect: GATT operation failed for unknown reason"), "Couldn't connect: GATT operation failed for unknown reason");
  assert.equal(scrub("doesn't fit, isn't ok"), "doesn't fit, isn't ok");
  assert.equal(scrub('timeout waiting for 03 01'), 'timeout waiting for 03 01');
  assert.equal(scrub('checksum mismatch on 03 01'), 'checksum mismatch on 03 01');
  assert.ok(scrub('x'.repeat(1000)).length <= 300);
});

test('detectApp', () => {
  assert.deepEqual(detectApp({ Capacitor: { getPlatform: () => 'android' } }), { app: 'android' });
  assert.deepEqual(detectApp({ Capacitor: { getPlatform: () => 'ios' } }), { app: 'ios' });
  assert.deepEqual(detectApp({ kindlingDesktop: { platform: 'win32' } }), { app: 'desktop', os: 'windows' });
  assert.deepEqual(detectApp({ kindlingDesktop: { platform: 'darwin' } }), { app: 'desktop', os: 'macos' });
  assert.deepEqual(detectApp({ kindlingDesktop: { platform: 'freebsd' } }), { app: 'desktop' });
  assert.deepEqual(detectApp({ Capacitor: { getPlatform: () => 'web' } }), { app: 'web' });
  assert.deepEqual(detectApp({}), { app: 'web' });
});

test('buildReport has only the allowed fields', () => {
  const err = new Error('stored "Secret name" failed');
  const r = buildReport(err, { where: 'save-preset', app: 'desktop', os: 'linux', version: '1.2.3' });
  assert.deepEqual(Object.keys(r).sort(), ['app', 'kind', 'message', 'name', 'os', 'stack', 'v', 'version', 'where']);
  assert.equal(r.message, 'stored "…" failed');
  assert.ok(!r.stack.includes('Secret'));
  assert.ok(!r.stack.includes('://'), 'stack frames keep only paths');
  assert.equal(buildReport('plain string').message, 'plain string');
  assert.equal(buildReport({ name: 'TypeError' }).name, 'TypeError');
});

test('sanitizeReport validates and re-scrubs', () => {
  const ok = { app: 'android', version: '0.3.0', kind: 'caught', name: 'Error', message: 'name "x"', stack: 'at /x.js:1:1', where: 'connect', ip: '1.2.3.4', userId: 'u1' };
  assert.deepEqual(sanitizeReport(ok), { app: 'android', version: '0.3.0', kind: 'caught', name: 'Error', message: 'name "…"', stack: 'at /x.js:1:1', where: 'connect', first: false });
  assert.equal(sanitizeReport({ ...ok, first: 'yes' }).first, false);
  assert.equal(sanitizeReport({ ...ok, first: true }).first, true);
  assert.equal(sanitizeReport({ ...ok, app: 'toaster' }), null);
  assert.equal(sanitizeReport({ ...ok, version: 'jeremy' }), null);
  assert.equal(sanitizeReport({ ...ok, kind: 'x' }), null);
  assert.equal(sanitizeReport([]), null);
  assert.equal(sanitizeReport({ ...ok, name: 'not a name!' }).name, 'Error');
  assert.equal(sanitizeReport({ ...ok, where: 'Bad Where' }).where, undefined);
  assert.equal(sanitizeReport({ ...ok, os: 'windows' }).os, undefined); // os only for desktop
  assert.equal(sanitizeReport({ ...ok, app: 'desktop', os: 'windows' }).os, 'windows');
});

test('fingerprint is stable and ignores numbers', async () => {
  const a = await fingerprint({ name: 'Error', message: 'timeout after 100 ms', stack: 'at f (/app/app.js:1:2)' });
  const b = await fingerprint({ name: 'Error', message: 'timeout after 250 ms', stack: 'at f (/app/app.js:1:2)' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

const tick = () => new Promise((r) => setTimeout(r, 30));

test('reporter: dev builds send nothing unless forced', async () => {
  const sent = [];
  const send = (url, body) => sent.push(JSON.parse(body));
  const dev = createReporter({ version: 'dev', app: 'web', send, storage: memoryStorage() });
  assert.equal(dev.available, false);
  assert.equal(dev.needsConsent, false);
  assert.equal(await dev.report(new Error('x')), null);
  const forced = createReporter({ version: 'dev', app: 'web', send, force: true, storage: memoryStorage() });
  forced.enabled = true;
  assert.ok(await forced.report(new Error('x')));
  assert.equal(sent.length, 1);
  assert.equal(createReporter({ endpoint: '', version: '1.0.0', app: 'web', send }).available, false);
});

test('reporter: opt-in; errors before the answer wait, and are dropped on "no"', async () => {
  for (const answer of [true, false]) {
    const sent = [];
    const storage = memoryStorage();
    const r = createReporter({ version: '1.0.0', app: 'android', storage, send: (u, b) => sent.push(JSON.parse(b)) });
    assert.equal(r.consent, null);
    assert.equal(r.needsConsent, true);
    assert.equal(r.enabled, false);
    for (let i = 0; i < 8; i++) await r.report(new Error(`early ${'x'.repeat(i)}`));
    assert.equal(sent.length, 0, 'nothing is sent before the user answers');
    r.enabled = answer;
    await tick();
    assert.equal(storage.getItem(PREF_KEY), answer ? 'on' : 'off');
    assert.equal(r.needsConsent, false);
    assert.equal(sent.length, answer ? 5 : 0, 'at most 5 are held');
  }
});

test('reporter: opt-out, dedupe, ignorable errors, never throws', async () => {
  const sent = [];
  const storage = memoryStorage();
  storage.setItem(PREF_KEY, 'on');
  const r = createReporter({ endpoint: 'https://e.test/v1/report', version: '1.0.0', app: 'ios', storage, send: (u, b) => sent.push([u, JSON.parse(b)]) });
  assert.equal(r.enabled, true);
  await r.report(new Error('boom'), { where: 'connect' });
  await r.report(new Error('boom'), { where: 'connect' }); // duplicate
  await r.report(Object.assign(new Error('User cancelled'), { name: 'NotFoundError' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'https://e.test/v1/report');
  assert.equal(sent[0][1].app, 'ios');
  assert.equal(sent[0][1].version, '1.0.0');
  r.enabled = false;
  assert.equal(storage.getItem(PREF_KEY), 'off');
  await r.report(new Error('another'));
  assert.equal(sent.length, 1);
  r.enabled = true;
  await r.report(new Error('another'));
  assert.equal(sent.length, 2);
  const broken = createReporter({ version: '1.0.0', app: 'ios', storage, send: () => { throw new Error('offline'); } });
  assert.equal(await broken.report(new Error('x')), null);
  for (let i = 0; i < 40; i++) await r.report(new Error(`e${'x'.repeat(i)}`));
  assert.ok(sent.length <= 20);
});

test('reporter: "first" is true once per install per error, with no id sent', async () => {
  const fail = (m) => new Error(m); // same code path = same top stack frame
  const storage = memoryStorage();
  storage.setItem(PREF_KEY, 'on');
  const sent = [];
  const make = () => createReporter({ version: '1.0.0', app: 'desktop', os: 'linux', storage, send: (u, b) => sent.push(JSON.parse(b)) });
  await make().report(fail('same'));
  await make().report(fail('same')); // next launch, same install
  await make().report(fail('different'));
  assert.deepEqual(sent.map((r) => r.first), [true, false, true]);
  assert.ok(sent.every((r) => Object.keys(r).every((k) => ['v', 'app', 'os', 'version', 'kind', 'name', 'message', 'stack', 'where', 'first'].includes(k))));
  const other = memoryStorage(); // another install
  other.setItem(PREF_KEY, 'on');
  await createReporter({ version: '1.0.0', app: 'android', storage: other, send: (u, b) => sent.push(JSON.parse(b)) }).report(fail('same'));
  assert.equal(sent.at(-1).first, true);
});

test('worker logs only the sanitised report', async () => {
  const logs = [];
  const log = { error: (o) => logs.push(o) };
  const body = JSON.stringify({ v: 1, app: 'desktop', os: 'macos', version: '0.3.0', kind: 'error', name: 'TypeError', message: 'bad "Amp of Jeremy"', ip: '1.2.3.4' });
  const req = new Request('https://errors.example/v1/report', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'Secret/1.0' },
  });
  const res = await handle(req, {}, undefined, log);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(logs.length, 1);
  const { fingerprint: fp, ...rest } = logs[0];
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.deepEqual(rest, { event: 'client_error', app: 'desktop', os: 'macos', version: '0.3.0', kind: 'error', name: 'TypeError', message: 'bad "…"', first: false });
  assert.ok(!JSON.stringify(logs).includes('1.2.3.4'));
  assert.ok(!JSON.stringify(logs).includes('Secret'));
});

test('worker rejects bad requests', async () => {
  const log = { error: () => assert.fail('should not log') };
  const post = (body, path = '/v1/report') => handle(new Request(`https://e.test${path}`, { method: 'POST', body }), {}, undefined, log);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(JSON.stringify({ app: 'x' }))).status, 400);
  assert.equal((await post('x'.repeat(9000))).status, 413);
  assert.equal((await post('{}', '/other')).status, 404);
  assert.equal((await handle(new Request('https://e.test/v1/report'), {}, undefined, log)).status, 405);
  assert.equal((await handle(new Request('https://e.test/v1/report', { method: 'OPTIONS' }), {}, undefined, log)).status, 204);
});

const SAMPLE_LOG = [
  'connecting to "Jeremy\'s Spark"',
  '0.100s ← [3:11] #5 ampName name=Spark 40 BLE',
  '    01 fe 00 00 53 53 f0 01 11 05 4a 53 70 61 72 6b',
  '0.200s → raw 01 fe 00 00 41 ff 1d 00',
  '0.300s ← [3:23] #6 serial serial=S999C123456',
  '0.400s ← [3:1] #2 preset "My Tone" slot=current Gate → Twin',
  'connect failed on S999C123456',
  'bluetooth: device AbC123dEf456GhI789== at /Users/jeremy/x.js, mail jeremy@example.com',
].join('\n');

test('scrubLog keeps raw bytes and removes names, ids, serials and paths from the text', () => {
  const out = scrubLog(SAMPLE_LOG);
  assert.match(out, /^    01 fe 00 00 53 53 f0 01 11 05 4a 53 70 61 72 6b$/m, 'hex lines kept as they are');
  assert.match(out, /→ raw 01 fe 00 00 41 ff 1d 00/);
  assert.match(out, /ampName …/);
  assert.match(out, /serial …$/m);
  assert.match(out, /preset "…" slot=current Gate → Twin/);
  assert.match(out, /connect failed on <id>/);
  assert.match(out, /^0\.100s ← \[3:11\] #5/m, 'timings and keys stay');
  for (const secret of ['Jeremy', 'Spark 40 BLE', 'S999C', 'My Tone', 'AbC123', 'jeremy@', '/Users/jeremy']) assert.ok(!out.includes(secret), secret);
  assert.equal(scrubLog(out), out, 'scrubbing twice changes nothing (the Worker re-scrubs)');
});

test('scrubLog keeps only the newest lines within the caps', () => {
  const many = Array.from({ length: LOG_LIMITS.lines + 50 }, (_, i) => `line ${i}`).join('\n');
  const out = scrubLog(many).split('\n');
  assert.equal(out.length, LOG_LIMITS.lines);
  assert.equal(out.at(-1), `line ${LOG_LIMITS.lines + 49}`);
  const long = Array.from({ length: 200 }, () => 'x'.repeat(300)).join('\n');
  assert.ok(scrubLog(long).length <= LOG_LIMITS.chars);
  assert.ok(scrubLog('y'.repeat(5000)).length <= LOG_LIMITS.line * 2);
  assert.equal(scrubLog(''), '');
});

test('buildLog and sanitizeLog: allow-listed fields only', () => {
  const r = buildLog(SAMPLE_LOG, { app: 'desktop', os: 'windows', version: '0.3.0', note: 'it broke, mail me at a@b.com', issue: 16 });
  assert.deepEqual(Object.keys(r).sort(), ['app', 'issue', 'kind', 'lines', 'log', 'note', 'os', 'v', 'version']);
  assert.equal(r.kind, 'log');
  assert.equal(r.lines, 8);
  assert.equal(r.note, 'it broke, mail me at <email>');
  const clean = sanitizeLog({ ...r, ip: '1.2.3.4', deviceId: 'x' });
  assert.deepEqual(Object.keys(clean).sort(), ['app', 'issue', 'kind', 'lines', 'log', 'note', 'os', 'version']);
  assert.equal(clean.log, r.log);
  // the Worker re-scrubs a log a modified client didn't scrub
  assert.ok(!sanitizeLog({ ...r, log: SAMPLE_LOG }).log.includes('My Tone'));
  assert.equal(sanitizeLog({ ...r, os: 'windows', app: 'android' }).os, undefined);
  assert.equal(sanitizeLog({ ...r, issue: '16' }).issue, undefined);
  assert.equal(sanitizeLog({ ...r, kind: 'error' }), null);
  assert.equal(sanitizeLog({ ...r, app: 'tv' }), null);
  assert.equal(sanitizeLog({ ...r, version: 'x' }), null);
  assert.equal(sanitizeLog({ ...r, log: '' }), null);
  assert.equal(sanitizeLog({ ...r, log: 'x'.repeat(LOG_LIMITS.chars * 2 + 1) }), null);
  assert.equal(sanitizeLog([]), null);
});

test('reporter.sendLog: user-initiated, independent of the error-report switch, capped per session', async () => {
  assert.equal(LOG_ENDPOINT, ENDPOINT.replace(/\/report$/, '/log'));
  const sent = [];
  const send = (url, body) => sent.push({ url, body: JSON.parse(body) });
  const storage = memoryStorage();
  storage.setItem(PREF_KEY, 'off');
  const r = createReporter({ version: '1.0.0', app: 'android', storage, send });
  assert.equal(r.canSendLog, true);
  assert.equal(await r.sendLog(''), null, 'empty logs are not sent');
  const out = await r.sendLog(SAMPLE_LOG, { note: 'n', issue: 3 });
  assert.equal(out.kind, 'log');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://errors.kindlingcontrol.app/v1/log');
  assert.equal(sent[0].body.issue, 3);
  await r.sendLog(SAMPLE_LOG);
  await r.sendLog(SAMPLE_LOG);
  assert.equal(r.canSendLog, false);
  assert.equal(await r.sendLog(SAMPLE_LOG), null);
  assert.equal(sent.length, 3);
  assert.equal(createReporter({ version: 'dev', app: 'web', send }).canSendLog, false, 'dev builds send nothing');
  assert.equal(createReporter({ endpoint: '', version: '1.0.0', app: 'web', send }).canSendLog, false);
});

test('worker /v1/log logs the re-scrubbed log under a random log_id', async () => {
  const logs = [];
  const log = { log: (o) => logs.push(o), error: () => assert.fail('not an error report') };
  const body = JSON.stringify({ ...buildLog(SAMPLE_LOG, { app: 'android', version: '0.3.0' }), extra: 'nope' });
  const req = new Request('https://e.test/v1/log', { method: 'POST', body, headers: { 'CF-Connecting-IP': '1.2.3.4', 'User-Agent': 'Secret/1.0' } });
  const res = await handle(req, {}, undefined, log);
  assert.equal(res.status, 204);
  assert.equal(logs.length, 1);
  const { log_id: id, ...rest } = logs[0];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(rest.event, 'console_log');
  assert.equal(rest.kind, 'log');
  assert.equal(rest.extra, undefined);
  assert.ok(!JSON.stringify(logs).includes('1.2.3.4'));
  assert.ok(!JSON.stringify(logs).includes('Secret'));
  const post = (b) => handle(new Request('https://e.test/v1/log', { method: 'POST', body: b }), {}, undefined, log);
  assert.equal((await post('nope')).status, 400);
  assert.equal((await post(JSON.stringify({ kind: 'log', app: 'web', version: 'dev', log: '' }))).status, 400);
  assert.equal((await post('x'.repeat(70 * 1024))).status, 413);
});

test('stamp-version writes the version', () => {
  const src = "export const VERSION = 'dev';\n";
  assert.equal(stamp(src, '1.2.3-beta.1'), "export const VERSION = '1.2.3-beta.1';\n");
  assert.throws(() => stamp(src, 'v1; rm -rf'), /not a version/);
  assert.throws(() => stamp('nothing here', '1.0.0'), /not found/);
});
