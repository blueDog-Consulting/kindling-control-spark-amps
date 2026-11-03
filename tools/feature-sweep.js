#!/usr/bin/env node
// Decides what the feature-request workflow does next for each issue. The workflow
// itself is a Claude Code cloud session that runs the `feature-sweep` skill
// (.claude/skills/feature-sweep/SKILL.md) on a schedule; this file keeps the rules
// deterministic and tested instead of leaving them to the model. See
// docs/FEATURE-WORKFLOW.md.
//
//   node tools/feature-sweep.js select <issues.json>   # JSON array of issues -> planned actions (JSON)
//   node tools/feature-sweep.js check-paths [base]     # fail if the branch touches a denied path
//
// An issue in issues.json may come from the GitHub REST/search API or the GitHub MCP
// tools: labels as strings or { name }, the type as `issue_type` ("Feature") or
// `type: { name }`, the author as `user.login`. Add `comments: [{ user: { login }, body }]`
// so runs can be counted.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH = '.github/feature-workflow.json';

/** Marker the session puts in every issue comment it posts; counts runs per issue. */
export const RUN_MARKER = '<!-- feature-sweep:run -->';

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const lower = (s) => String(s ?? '').toLowerCase();

export function labelsOf(issue) {
  return (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}

export function typeOf(issue) {
  const t = issue.issue_type ?? issue.type;
  return typeof t === 'string' ? t : (t?.name ?? '');
}

export function authorOf(issue) {
  return issue.user?.login ?? issue.author?.login ?? '';
}

export function isMaintainer(login, config) {
  return config.maintainers.some((m) => lower(m) === lower(login));
}

export function isFeatureRequest(issue, config) {
  const labels = labelsOf(issue).map(lower);
  return (
    config.trigger.types.some((t) => lower(t) === lower(typeOf(issue))) ||
    config.trigger.labels.some((l) => labels.includes(lower(l)))
  );
}

/** Runs so far: maintainer-authored comments carrying RUN_MARKER (the session posts as the maintainer). */
export function runsOf(issue, config) {
  return (issue.comments ?? []).filter(
    (c) => typeof c === 'object' && isMaintainer(c.user?.login ?? c.author?.login, config) && String(c.body).includes(RUN_MARKER),
  ).length;
}

/**
 * What to do with one issue.
 * @returns {{ number: number, action: 'plan'|'implement'|'block'|'skip', reason: string }}
 */
export function nextStep(issue, config) {
  const L = config.labels;
  const labels = new Set(labelsOf(issue));
  const out = (action, reason) => ({ number: issue.number, action, reason });

  if (!config.enabled) return out('skip', 'workflow disabled in ' + CONFIG_PATH);
  if (issue.pull_request) return out('skip', 'pull request');
  if (lower(issue.state) !== 'open') return out('skip', 'closed');
  if (!isFeatureRequest(issue, config)) return out('skip', 'not a feature request');
  if (labels.has(L.skip)) return out('skip', `labelled ${L.skip}`);
  if (labels.has(L.blocked)) return out('skip', `labelled ${L.blocked}`);
  if (labels.has(L.implemented)) return out('skip', 'already implemented');
  if (!isMaintainer(authorOf(issue), config) && !labels.has(L.go)) {
    return out('skip', `author is not a maintainer; a maintainer can add ${L.go}`);
  }

  const runs = runsOf(issue, config);
  const planned = labels.has(L.planned);
  const approved = labels.has(L.approved);
  const wants = !planned ? 'plan' : approved ? 'implement' : null;
  if (!wants) return out('skip', `plan is waiting for ${L.approved}`);
  if (runs >= config.maxRunsPerIssue) return out('block', `run limit reached (${runs}/${config.maxRunsPerIssue})`);
  return out(wants, `${wants === 'plan' ? 'no plan yet' : 'plan approved'} (run ${runs + 1}/${config.maxRunsPerIssue})`);
}

/** Every issue's step, plus the work for this sweep: implement before plan, oldest first, capped. */
export function select(issues, config) {
  const steps = issues.map((i) => nextStep(i, config)).sort((a, b) => a.number - b.number);
  const rank = { implement: 0, plan: 1, block: 2 };
  const work = steps
    .filter((s) => s.action in rank)
    .sort((a, b) => rank[a.action] - rank[b.action] || a.number - b.number);
  const blocks = work.filter((s) => s.action === 'block');
  const runs = work.filter((s) => s.action !== 'block').slice(0, config.maxIssuesPerSweep);
  return { todo: [...runs, ...blocks], all: steps };
}

export function slug(title) {
  return lower(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'feature';
}

/** The branch and plan files for an issue; stable so a later run finds the earlier one's work. */
export function namesFor(issue, config) {
  const base = `${issue.number}-${slug(issue.title)}`;
  return {
    branch: `${config.branchPrefix}${base}`,
    design: `${config.plansDir}/issue-${base}-design.md`,
    plan: `${config.plansDir}/issue-${base}-plan.md`,
  };
}

/** Changed paths the workflow may not touch (prefix match; a trailing "/" means a folder). */
export function deniedPaths(files, config) {
  return files.filter((f) => config.deniedPaths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const config = loadConfig();
  if (cmd === 'select') {
    if (!arg) throw new Error('usage: feature-sweep.js select <issues.json>');
    const issues = JSON.parse(readFileSync(arg, 'utf8'));
    const r = select(issues, config);
    for (const i of r.todo) Object.assign(i, namesFor(issues.find((x) => x.number === i.number), config));
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'check-paths') {
    const base = arg || 'origin/main';
    const files = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const bad = deniedPaths(files, config);
    if (bad.length) {
      console.error(`feature-sweep: this branch changes paths the workflow may not touch:\n${bad.map((f) => `  ${f}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`feature-sweep: ${files.length} changed path(s), none denied. ✓`);
    }
  } else {
    console.error('usage: feature-sweep.js select <issues.json> | check-paths [base]');
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
