import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, detectApp, buildReport, sanitizeReport, createReporter, fingerprint, PREF_KEY } from '../src/app/telemetry.js';
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
  assert.deepEqual(sanitizeReport(ok), { app: 'android', version: '0.3.0', kind: 'caught', name: 'Error', message: 'name "…"', stack: 'at /x.js:1:1', where: 'connect' });
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

test('reporter: dev builds send nothing unless forced', () => {
  const sent = [];
  const send = (url, body) => sent.push(JSON.parse(body));
  const dev = createReporter({ version: 'dev', app: 'web', send });
  assert.equal(dev.available, false);
  assert.equal(dev.report(new Error('x')), null);
  const forced = createReporter({ version: 'dev', app: 'web', send, force: true });
  assert.ok(forced.report(new Error('x')));
  assert.equal(sent.length, 1);
  assert.equal(createReporter({ endpoint: '', version: '1.0.0', app: 'web', send }).available, false);
});

test('reporter: opt-out, dedupe, ignorable errors, never throws', () => {
  const sent = [];
  const storage = memoryStorage();
  const r = createReporter({ endpoint: 'https://e.test/v1/report', version: '1.0.0', app: 'ios', storage, send: (u, b) => sent.push([u, JSON.parse(b)]) });
  assert.equal(r.enabled, true);
  r.report(new Error('boom'), { where: 'connect' });
  r.report(new Error('boom'), { where: 'connect' }); // duplicate
  r.report(Object.assign(new Error('User cancelled'), { name: 'NotFoundError' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'https://e.test/v1/report');
  assert.equal(sent[0][1].app, 'ios');
  assert.equal(sent[0][1].version, '1.0.0');
  r.enabled = false;
  assert.equal(storage.getItem(PREF_KEY), 'off');
  r.report(new Error('another'));
  assert.equal(sent.length, 1);
  r.enabled = true;
  r.report(new Error('another'));
  assert.equal(sent.length, 2);
  const broken = createReporter({ version: '1.0.0', app: 'ios', send: () => { throw new Error('offline'); } });
  assert.equal(broken.report(new Error('x')), null);
  for (let i = 0; i < 40; i++) r.report(new Error(`e${'x'.repeat(i)}`));
  assert.ok(sent.length <= 20);
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
  const res = await handle(req, log);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(logs.length, 1);
  const { fingerprint: fp, ...rest } = logs[0];
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.deepEqual(rest, { event: 'client_error', app: 'desktop', os: 'macos', version: '0.3.0', kind: 'error', name: 'TypeError', message: 'bad "…"' });
  assert.ok(!JSON.stringify(logs).includes('1.2.3.4'));
  assert.ok(!JSON.stringify(logs).includes('Secret'));
});

test('worker rejects bad requests', async () => {
  const log = { error: () => assert.fail('should not log') };
  const post = (body, path = '/v1/report') => handle(new Request(`https://e.test${path}`, { method: 'POST', body }), log);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(JSON.stringify({ app: 'x' }))).status, 400);
  assert.equal((await post('x'.repeat(9000))).status, 413);
  assert.equal((await post('{}', '/other')).status, 404);
  assert.equal((await handle(new Request('https://e.test/v1/report'), log)).status, 405);
  assert.equal((await handle(new Request('https://e.test/v1/report', { method: 'OPTIONS' }), log)).status, 204);
});

test('stamp-version writes the version', () => {
  const src = "export const VERSION = 'dev';\n";
  assert.equal(stamp(src, '1.2.3-beta.1'), "export const VERSION = '1.2.3-beta.1';\n");
  assert.throws(() => stamp(src, 'v1; rm -rf'), /not a version/);
  assert.throws(() => stamp('nothing here', '1.0.0'), /not found/);
});
