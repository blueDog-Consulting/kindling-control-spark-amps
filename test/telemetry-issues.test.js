// The error-report Worker's D1 counting and GitHub issue creation, against a real
// SQLite database (node:sqlite) standing in for D1, and a fake GitHub API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { track, issueBody, handle, ISSUE_LABEL } from '../telemetry/worker.js';

let sqlite = null;
try {
  process.removeAllListeners('warning'); // node:sqlite is experimental; keep test output clean
  sqlite = await import('node:sqlite');
} catch {}

/** Minimal D1 API (prepare/bind/first/run) over node:sqlite. */
function fakeD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../telemetry/schema.sql', import.meta.url), 'utf8'));
  return {
    db,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => ((args = a), stmt),
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      };
      return stmt;
    },
  };
}

const report = (over = {}) => ({ app: 'android', version: '0.3.0', kind: 'caught', name: 'Error', message: 'timeout waiting for 03 01', where: 'connect', stack: 'at f (/spark/client.js:190:20)', first: true, ...over });
const quiet = { log() {}, warn() {}, error() {} };

function fakeGitHub() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ number: 41 + calls.length }), { status: 201 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test('counts installs (first = true only) and opens one issue at the threshold', { skip: !sqlite && 'needs node:sqlite' }, async () => {
  const DB = fakeD1();
  const gh = fakeGitHub();
  try {
    const env = { DB, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r', ISSUE_THRESHOLD: '2' };
    let r = await track(env, 'abc', report(), quiet, '2026-11-01');
    assert.equal(r.row.installs, 1);
    assert.equal(r.issue, null);
    r = await track(env, 'abc', report({ first: false }), quiet, '2026-11-01'); // same install again
    assert.equal(r.row.installs, 1);
    assert.equal(r.row.reports, 2);
    assert.equal(gh.calls.length, 0);
    r = await track(env, 'abc', report({ app: 'desktop', os: 'windows', version: '0.3.1' }), quiet, '2026-11-02');
    assert.equal(r.row.installs, 2);
    assert.equal(r.issue.number, 42);
    assert.equal(gh.calls.length, 1);
    const { url, init, body } = gh.calls[0];
    assert.equal(url, 'https://api.github.com/repos/o/r/issues');
    assert.equal(init.headers.Authorization, 'Bearer t');
    assert.deepEqual(body.labels, [ISSUE_LABEL]);
    assert.match(body.title, /^\[error\] Error: timeout waiting for 03 01/);
    assert.match(body.body, /android,desktop\/windows/);
    assert.match(body.body, /first seen 0\.3\.0, latest 0\.3\.1/);
    // more reports don't open more issues
    await track(env, 'abc', report(), quiet, '2026-11-02');
    assert.equal(gh.calls.length, 1);
    const row = DB.db.prepare('SELECT issue_number, issue_state, installs FROM errors WHERE fingerprint = ?').get('abc');
    assert.deepEqual({ ...row }, { issue_number: 42, issue_state: 'open', installs: 3 });
  } finally {
    gh.restore();
  }
});

test('no token or repo: counts only; daily cap; GitHub failure releases the claim', { skip: !sqlite && 'needs node:sqlite' }, async () => {
  const DB = fakeD1();
  const gh = fakeGitHub();
  try {
    await track({ DB }, 'x', report(), quiet, '2026-11-01');
    assert.equal((await track({ DB }, 'x', report(), quiet, '2026-11-01')).row.installs, 2);
    assert.equal(gh.calls.length, 0);

    const env = { DB, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r', ISSUE_THRESHOLD: '1', MAX_ISSUES_PER_DAY: '2' };
    for (const fp of ['a', 'b', 'c']) await track(env, fp, report({ message: fp }), quiet, '2026-11-01');
    assert.equal(gh.calls.length, 2, 'capped at 2 issues a day');
    await track(env, 'c', report({ message: 'c', first: false }), quiet, '2026-11-02');
    assert.equal(gh.calls.length, 3, 'opened the next day');

    globalThis.fetch = async () => new Response('nope', { status: 500 });
    await assert.rejects(track(env, 'd', report({ message: 'd' }), quiet, '2026-11-03'), /500/);
    const row = DB.db.prepare('SELECT issue_state, issue_created FROM errors WHERE fingerprint = ?').get('d');
    assert.deepEqual({ ...row }, { issue_state: null, issue_created: null });
  } finally {
    gh.restore();
  }
});

test('handle() tracks in the background when DB is bound', { skip: !sqlite && 'needs node:sqlite' }, async () => {
  const DB = fakeD1();
  const waits = [];
  const req = new Request('https://e.test/v1/report', { method: 'POST', body: JSON.stringify({ v: 1, ...report() }) });
  const res = await handle(req, { DB }, { waitUntil: (p) => waits.push(p) }, quiet);
  assert.equal(res.status, 204);
  await Promise.all(waits);
  assert.equal(DB.db.prepare('SELECT count(*) AS n FROM errors').get().n, 1);
});

test('issue body has the machine-readable report block and nothing else from the request', () => {
  const body = issueBody('abc', report(), { installs: 2, reports: 3, apps: 'android', first_version: '0.3.0', last_version: '0.3.0' });
  const json = JSON.parse(/<!-- error-report -->\n```json\n([\s\S]+?)\n```/.exec(body)[1]);
  assert.deepEqual(Object.keys(json), ['fingerprint', 'name', 'message', 'where', 'stack']);
});
