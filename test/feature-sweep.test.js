import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { RUN_MARKER, deniedPaths, loadConfig, namesFor, nextStep, select, slug } from '../tools/feature-sweep.js';
import { MATERIAL } from '../tools/check-docs.js';

const repoConfig = loadConfig();
const config = { ...repoConfig, enabled: true };
const L = config.labels;

const issue = (over = {}) => ({
  number: 20,
  title: 'Need ability to copy Console output ',
  state: 'open',
  user: { login: 'jerdog' },
  labels: ['enhancement'],
  ...over,
});
const run = (login = 'jerdog') => ({ user: { login }, body: `Plan posted. ${RUN_MARKER}` });

test('the committed config is off until a maintainer turns it on', () => {
  assert.equal(repoConfig.enabled, false);
  assert.equal(nextStep(issue(), repoConfig).action, 'skip');
});

test('feature type or enhancement label starts planning', () => {
  assert.equal(nextStep(issue(), config).action, 'plan');
  assert.equal(nextStep(issue({ labels: [], issue_type: 'Feature' }), config).action, 'plan');
  assert.equal(nextStep(issue({ labels: [{ name: 'Enhancement' }] }), config).action, 'plan');
  assert.equal(nextStep(issue({ labels: [], type: { name: 'Feature' } }), config).action, 'plan');
  assert.equal(nextStep(issue({ labels: ['bug'], issue_type: 'Bug' }), config).action, 'skip');
});

test('only maintainers, or issues a maintainer vouched for', () => {
  const outsider = issue({ user: { login: 'someone-else' } });
  assert.equal(nextStep(outsider, config).action, 'skip');
  assert.equal(nextStep({ ...outsider, labels: ['enhancement', L.go] }, config).action, 'plan');
  assert.equal(nextStep(issue({ user: { login: 'JerDog' } }), config).action, 'plan', 'logins are case-insensitive');
});

test('closed, pull requests, skip, blocked and implemented are left alone', () => {
  assert.equal(nextStep(issue({ state: 'CLOSED' }), config).action, 'skip');
  assert.equal(nextStep(issue({ pull_request: {} }), config).action, 'skip');
  for (const l of [L.skip, L.blocked, L.implemented]) {
    assert.equal(nextStep(issue({ labels: ['enhancement', L.planned, L.approved, l] }), config).action, 'skip', l);
  }
});

test('a plan waits for approval, then implements', () => {
  assert.match(nextStep(issue({ labels: ['enhancement', L.planned] }), config).reason, /waiting/);
  assert.equal(nextStep(issue({ labels: ['enhancement', L.planned, L.approved] }), config).action, 'implement');
  assert.equal(nextStep(issue({ labels: ['enhancement', L.approved] }), config).action, 'plan', 'approval before a plan exists');
});

test('run limit blocks an issue; only maintainer comments with the marker count', () => {
  const four = [run(), run(), run(), run(), run('someone-else'), { user: { login: 'jerdog' }, body: 'no marker' }];
  assert.equal(nextStep(issue({ comments: four }), config).action, 'plan');
  const five = [...four, run()];
  const r = nextStep(issue({ comments: five }), config);
  assert.equal(r.action, 'block');
  assert.match(r.reason, /5\/5/);
});

test('select implements before planning, oldest first, capped per sweep', () => {
  const issues = [
    issue({ number: 30 }),
    issue({ number: 25, labels: ['enhancement', L.planned, L.approved] }),
    issue({ number: 21 }),
    issue({ number: 22, comments: Array(5).fill(run()) }),
    issue({ number: 23, labels: ['bug'] }),
  ];
  const one = select(issues, config);
  assert.deepEqual(one.todo.map((s) => [s.number, s.action]), [[25, 'implement'], [22, 'block']]);
  assert.equal(one.all.length, 5);
  const three = select(issues, { ...config, maxIssuesPerSweep: 3 });
  assert.deepEqual(three.todo.map((s) => s.number), [25, 21, 30, 22]);
});

test('branch and plan names are stable and safe', () => {
  assert.equal(slug('Need ability to copy Console output '), 'need-ability-to-copy-console-output');
  assert.equal(slug('!!!'), 'feature');
  assert.ok(slug('x'.repeat(100)).length <= 40);
  const n = namesFor(issue(), config);
  assert.equal(n.branch, 'claude/feature-20-need-ability-to-copy-console-output');
  assert.equal(n.plan, 'docs/plans/issue-20-need-ability-to-copy-console-output-plan.md');
  assert.ok(MATERIAL.every((re) => !re.test(n.plan)), 'plans are docs, not material');
});

test('denied paths cover the licence, CI, telemetry and the workflow itself', () => {
  const files = [
    'LICENSE',
    '.github/workflows/ci.yml',
    'telemetry/worker.js',
    '.claude/settings.json',
    '.github/feature-workflow.json',
    'tools/feature-sweep.js',
    'src/app/app.js',
    'docs/plans/issue-1-x-plan.md',
    'LICENSE.md',
  ];
  assert.deepEqual(deniedPaths(files, config), files.slice(0, 6));
});

test('no issue template can apply the workflow labels for an outsider', () => {
  const dir = '.github/ISSUE_TEMPLATE';
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    for (const l of Object.values(L)) assert.ok(!text.includes(l), `${f} mentions ${l}`);
  }
});
