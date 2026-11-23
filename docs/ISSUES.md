# Issues, labels and the project board

How issues are filed, labelled and tracked. Work is planned on one organisation-level GitHub Project for KindlingControl that pulls in this repository and the website repository.

## Issue forms

`.github/ISSUE_TEMPLATE/` holds the forms people see when they open an issue:

| File | Sets | Asks for |
|---|---|---|
| `bug.yml` | type **Bug** | what happened, steps, **App** (multi-select), app version, device/OS, amp model, firmware, Console log |
| `feature.yml` | type **Feature** | the goal, an idea, **App**, amp model |
| `config.yml` | | links to the guide's troubleshooting section and the presets hub; blank issues stay allowed |

The forms deliberately apply **no labels**:

- `bug` starts the auto-fix workflow (`.github/workflows/autofix.yml`, see [TELEMETRY.md](TELEMETRY.md)), so it's added at triage, after `triaged`, as before.
- `enhancement` and the `superpowers:*` labels drive the feature-request workflow ([FEATURE-WORKFLOW.md](FEATURE-WORKFLOW.md)); `test/feature-sweep.test.js` fails if a form mentions a workflow label. A form-set type **Feature** is safe: that workflow only acts on issues by maintainers.

## Platform labels

Most code is shared (`src/` ships in every app), so **an issue without a platform label affects all platforms**. Add a platform label only when a problem or feature is specific to some apps. An issue can have several.

| Label | App |
|---|---|
| `platform:desktop` | Electron (`desktop/`) |
| `platform:android` | Capacitor Android (`android/`) |
| `platform:ios` | Capacitor iOS (`ios/`, planned) |
| `platform:web` | browser development build (`npm run serve`) |

`.github/workflows/issue-platforms.yml` adds them automatically when an issue is opened or edited: `tools/issue-platforms.js` reads the form's **App** answer and maps each option, by exact text, to a label (`PLATFORMS`). "Not sure" maps to nothing. It only adds labels and never removes them, so corrections made at triage stay. The first time a label is needed the workflow creates it with the colour and description in `PLATFORMS`.

The issue body is untrusted. It reaches the script through `env`, and only the fixed option texts can produce a label, so a body can't choose a label name. If you change an option, change it in **both** forms and in `PLATFORMS`; `test/issue-platforms.test.js` checks they match, and that no option contains a comma (multi-select answers are comma-separated).

Other labels in use: `bug`, `enhancement`, `triaged`, `needs-info`, `accessibility`, `error-report` (opened by the error-report Worker), `docs-not-needed` (PRs), and the `superpowers:*` workflow labels.

## The project board (set up by hand)

Projects aren't configured from this repository; a maintainer sets them up in the organisation's **Projects** tab. The recommended setup:

- **Owner:** the `bluedog-consulting` organisation, so it can hold items from this repo and `kindling-control-website`. Leave the private repo's items out (or keep the project private).
- **Built-in workflows:** auto-add issues and PRs from both repos; item closed → Done; PR merged → Done; auto-archive after two weeks.
- **Fields:**
  - **Status:** Triage → Backlog → Ready → In progress → In review → Done
  - **Area:** Protocol (`src/spark/`), UI/rig, Transport, Shell (Electron/Capacitor), Release/CI, Telemetry, Guide/docs, Website
  - **Priority:** P0, P1, P2
  - **Size:** S, M, L
  - **Target release:** v0.4, v0.5, …
  - **Amp model:** optional
- **Platform** stays a label, not a field: a project single-select can't hold more than one platform.
- **Views:**
  - **Board** by Status
  - **By platform:** table grouped by labels
  - **Roadmap** by Target release
  - **Automation:** `label:error-report,superpowers:planned,superpowers:approved,superpowers:blocked`
  - **iOS launch:** `label:platform:ios`
- **Big pieces of work** (such as the iOS app) are a parent issue with sub-issues, so the board shows their progress.
