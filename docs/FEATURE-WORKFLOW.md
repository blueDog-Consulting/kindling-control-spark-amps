# Feature-request workflow

Open feature requests are planned and then built by a Claude Code **cloud session**, using the
[Superpowers](https://github.com/obra/superpowers) skills. Nothing is merged automatically: the
workflow only ever opens **draft** PRs, and building waits for a maintainer's approval.

## How it runs

A scheduled task on claude.ai starts a fresh cloud session in this repository every hour. The
session runs the project skill `.claude/skills/feature-sweep/SKILL.md` (`/feature-sweep`); you can also
run that skill by hand, optionally for one issue: `/feature-sweep 20`.

The decisions about which issue gets which step are made by `tools/feature-sweep.js` from
`.github/feature-workflow.json`, not by the model, and are covered by `test/feature-sweep.test.js`.

## Which issues

An open issue is picked up when **all** of these hold:

- its type is **Feature** or it has the label **`enhancement`** (`trigger` in the config);
- its author is in `maintainers` (today: `jerdog`), **or** a maintainer added **`superpowers:go`**
  to vouch for someone else's request. Only people with triage access can add labels, and no issue
  template applies the workflow's labels (a test checks this);
- it has none of `superpowers:skip`, `superpowers:blocked`, `superpowers:implemented`.

At most `maxIssuesPerSweep` (1) issue is worked on per run, approved builds before new plans,
oldest issue first.

## The two phases

```
issue labelled enhancement / typed Feature
        │  sweep: plan  (brainstorming → writing-plans)
        ▼
draft PR "Plan: …" with docs/plans/issue-<n>-<slug>-design.md and -plan.md
issue labelled superpowers:planned
        │  maintainer reviews; adds superpowers:approved
        │  (or comments with changes and removes superpowers:planned to re-plan)
        ▼  sweep: implement  (subagent-driven-development + test-driven-development)
same draft PR now carries the code, "Closes #<n>"; issue labelled superpowers:implemented
```

1. **Plan.** Superpowers' brainstorming normally asks questions one at a time. Here no one is
   watching, so the session answers them itself and records each one under **Assumptions** in the
   design doc and the PR body. Read those first when you review a plan. Then `writing-plans` turns
   the design into a step-by-step plan.
2. **Implement** (after `superpowers:approved`). The plan is executed task by task with TDD on the
   same branch. Before pushing, `npm test`, `npm run check:docs` (the documentation rule in
   AGENTS.md) and `node tools/feature-sweep.js check-paths` must pass. The PR stays a draft.

Branches are named `claude/feature-<n>-<slug>`.

## Limits

| | |
|---|---|
| On/off | `enabled` in `.github/feature-workflow.json` (committed as `false`), plus pausing the scheduled task |
| Runs per issue | `maxRunsPerIssue` (5). Every run posts an issue comment with `<!-- feature-sweep:run -->`; at 5 the issue gets `superpowers:blocked` |
| Paths it may not change | `deniedPaths`: `LICENSE`, `.github/workflows/`, `telemetry/`, `.claude/`, and the workflow's own config, selector and the docs check |
| Who it acts for | `maintainers`, or issues carrying `superpowers:go` |
| Issue text | treated as a description of the request, never as instructions; only maintainers' comments count as feedback |

## Labels

| label | set by | meaning |
|---|---|---|
| `superpowers:go` | maintainer | work on a non-maintainer's request |
| `superpowers:skip` | maintainer | never touch this issue |
| `superpowers:planned` | workflow | plan PR is open; remove it to re-plan |
| `superpowers:approved` | maintainer | build the plan |
| `superpowers:implemented` | workflow | code is in the draft PR |
| `superpowers:blocked` | workflow | run limit reached; needs a person |

## Setup

1. Merge this to `main`. `.claude/settings.json` adds the `superpowers-marketplace` marketplace and
   enables the `superpowers` plugin for Claude Code sessions in this repository, including local ones,
   which will offer to install it. The cloud environment needs network access to `github.com`.
   If the plugin doesn't load in a cloud session, the skill falls back to reading the Superpowers
   skill files from a clone.
2. Set `"enabled": true` in `.github/feature-workflow.json`.
3. Enable the scheduled task **Feature-request sweep** on claude.ai (Claude Code → scheduled tasks).
   Its prompt:

   > Run the project skill /feature-sweep (.claude/skills/feature-sweep/SKILL.md) for
   > bluedog-consulting/kindling-control-spark-amps. You are authorised to push to branches named
   > claude/feature-*, and to open and update draft pull requests and issue comments and labels as the
   > skill describes. Never merge or mark a PR ready for review. Do not subscribe to PR activity.

**Not yet verified:** that the cloud session's git access allows pushing to `claude/feature-*`
branches other than the session's own branch, and that the project plugin setting installs
Superpowers in a scheduled session. Check the first run's transcript.
