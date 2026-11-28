# Releasing

Releases are cut by pushing a version tag. `.github/workflows/release.yml` then:

1. runs the tests
2. works out which apps changed since the previous `v*` tag (`tools/release-plan.js`)
3. builds only those apps
4. publishes one GitHub Release with the downloads and a table of what was built and why

```sh
npm run release -- v0.2.0            # or v0.2.0-beta.1 for a pre-release; add --dry-run to rehearse
```

`tools/release.js` does the whole sequence, in the order the workflow needs, and stops at the first problem before anything is pushed:

1. checks the tag is a new semantic version (not on your machine or on `origin`), you are on a clean `main` that isn't behind `origin/main`, and `npm test` passes
2. works out whether the release needs store notes (a final tag that builds Android does; see "Store release notes"). If `release-notes/<version>/android.txt` is missing or invalid it drafts one from the commit subjects since the previous tag and opens it in `$VISUAL`/`$EDITOR`, re-opening it until it validates
3. asks for confirmation, then commits the notes, pushes `main`, creates the tag and pushes the tag

`--dry-run` runs the checks and prints the draft notes and the git commands without changing anything. `--yes` skips the confirmation, but opens no editor, so the notes must already exist. By hand, the same thing is: write and commit the notes, `git push origin main`, `git tag v0.2.0`, `git push origin v0.2.0`. Push the notes before the tag: the workflow checks out the tag and fails early without them.

Watch it under **Actions → Release**. To rebuild an existing tag, for example after adding secrets, run the workflow manually (*Run workflow*), give it the tag, and tick **force** to build every app.

## Versions

- Tags must be semantic versions: `vMAJOR.MINOR.PATCH`, optionally `-alpha.N`, `-beta.N` or `-rc.N`. Minor and patch go up to 99; pre-release numbers up to 32.
- The version comes from the tag. You don't need to bump `package.json` by hand; CI sets it at build time.
- Both app builds write the version into `src/version.js` (committed as `'dev'`) with `tools/stamp-version.js`: `tools/release-android.sh` does it just before `cap sync` and then restores the file (so local builds leave the working tree clean), and the desktop job does it before electron-builder. The anonymous error reports use it, and only stamped builds send them ([TELEMETRY.md](TELEMETRY.md)).
- Android needs an increasing integer `versionCode`, derived as `major·1 000 000 + minor·10 000 + patch·100 + suffix`. The suffix is alpha 0–32, beta 33–65, rc 66–98, and 99 for a final release. So `1.2.3-beta.1` (1020334) < `1.2.3-rc.1` (1020367) < `1.2.3` (1020399), and phones accept every upgrade.
- A tag with a `-` suffix is published as a GitHub **pre-release**.

## Store release notes

The "What's new" text for the store listings is versioned with the release. It lives in `release-notes/<version>/` (the tag without the `v`), one plain-text file per store:

| File | Store | Limit |
|---|---|---|
| `android.txt` | Google Play, "What's new" | 500 characters |
| `ios.txt` | App Store (iPhone and iPad), "What's New in This Version" | 4000 characters |
| `macos.txt` | Mac App Store, "What's New in This Version" | 4000 characters |

They must be committed and pushed before you tag, so `v0.2.0` ships exactly `release-notes/0.2.0/`. `npm run release` does that for you (it drafts `android.txt` and opens your editor); `macos.txt` stays a manual, optional file. Details and an example layout are in [release-notes/README.md](../release-notes/README.md).

- Store notes belong to the apps a release builds. The `plan` job works out that set (today: Android, when it's built) and checks only those notes, with `release-notes.js --only`. A **final** tag that builds Android fails right away if `android.txt` is missing, empty or over the limit, before anything is built. Pre-release tags need no notes, and a release that builds no store app checks none.
- `ios.txt` is optional and validated like `macos.txt`. CI builds iOS only as an unsigned compile check (below), which ships nowhere, so CI neither checks nor publishes `ios.txt`; check it with `npm run release:notes` and paste it into App Store Connect. Signed iOS builds are uploaded by hand (see *Signed builds for TestFlight*), so `ios.txt` stays optional; if CI ever ships iOS, add `ios` to the plan job's set and to the "needs notes" rule in `tools/release.js` together.
- `macos.txt` is optional. macOS isn't built in CI, so CI neither checks nor publishes it; check it with `npm run release:notes` and paste it into App Store Connect when you ship the Mac app. Once macOS joins the build matrix, add `macos` to the plan job's set with the desktop build.
- The `release` job checks out the tag and publishes exactly the plan job's set: a **Store release notes** section in the GitHub Release body and `kindling-control-<version>-android-whatsnew.txt`, ready to paste into Play Console. A release that skipped Android carries no Play notes. Nothing is uploaded to a store automatically yet.
- Check ahead of time: `npm run release:notes -- v0.2.0 --require android`.

## What gets built

| App | Rebuilt when these change | Output |
|---|---|---|
| Android | `src/`, `android/`, `capacitor.config.json`, `package.json`, `package-lock.json` | `…-android.apk` + `.aab` (signed), or `…-android-debug.apk` |
| Desktop | `src/`, `desktop/`, `build/` (icons), `package.json`, `package-lock.json` | Windows `.exe` (NSIS), Linux `.AppImage` + `.deb` |
| iOS (compile check) | `src/`, `ios/`, `capacitor.config.json`, `package.json`, `package-lock.json` | nothing published: an unsigned iOS Simulator app, kept as the `ios-simulator-app` workflow artifact |

- Changes that only touch docs, tests, tools or `telemetry/` build nothing. The error-report Worker in `telemetry/` is deployed by hand with wrangler ([TELEMETRY.md](TELEMETRY.md)).
- An app that is skipped keeps its downloads on the earlier release, and the release notes say so.
- The first tag (no earlier `v*` tag) builds everything.

**macOS** isn't in the pipeline yet either: its build doesn't work in CI so far, so it was taken out of the desktop matrix in `release.yml` to keep it from blocking releases (any failed build skips publishing). Build the `.dmg` locally with `npm run desktop:dist` on a Mac (see [APPS.md](APPS.md)), and add the `macos-latest` row back once it builds.

## Android test builds (not releases)

`.github/workflows/android-debug.yml` builds a **debug-signed APK** for testing a pull request on a phone. It runs on every PR that touches the Android app's paths (the list above, plus `tools/release-android.sh` and the workflow itself), and by hand from **Actions → Android test build → Run workflow** once the file is on `main`. It tags nothing and publishes nothing: the APK is a workflow artifact (`android-debug-apk`, kept 14 days) on the run's summary page, and downloading it needs a GitHub login. It goes through the same `tools/release-android.sh --debug` as releases. The version name is the latest tag plus `-pr<N>` (or `-dev`), e.g. `0.2.0-pr7`, which `src/version.js` is stamped with, so opted-in error reports from test builds are identifiable. `versionFromTag()` gives any suffix other than `alpha`/`beta`/`rc` the lowest `versionCode` for that version (suffix 0), so every PR number works; before that, PRs above #32 failed with `pre-release number must be 0-32` (#48). A debug-signed APK can't update an installed Play Store or release-signed copy: testers uninstall that first (which clears **My presets**, so they should export them).

## iOS builds

The iPhone and iPad app isn't released yet. CI can prove it **compiles**, with no Apple account or secrets, but **that's switched off until iOS builds start**: both workflows below run their iOS job only when the repo variable `IOS_BUILDS_ENABLED` is `true` (*Settings → Secrets and variables → Actions → Variables*). Unset or anything else, the jobs show as skipped and use no macOS runner minutes. `npm run release:ios` works locally either way.

- `tools/release-ios.sh` (`npm run release:ios -- [vX.Y.Z] [--skip-install]`) is the one iOS build path, like `release-android.sh` for Android. On macOS with Xcode it stamps `src/version.js` (and restores it), runs `npx cap sync ios`, and builds the `App` scheme for the iOS Simulator with `CODE_SIGNING_ALLOWED=NO`. `CFBundleShortVersionString` is the tag's `MAJOR.MINOR.PATCH` (Apple allows only numbers) and `CFBundleVersion` is `versionFromTag()`'s code, the same strictly increasing number as Android's `versionCode`; the script checks the built app carries it. Output: `out/kindling-control-<version>-ios-simulator.zip`.
- `release.yml` runs it in an `ios` job on `macos-latest` when the plan says iOS changed. The job has `continue-on-error: true` and the `release` job doesn't wait for it, so a broken iOS build can never block the Android and desktop release (the reason macOS desktop left the matrix). Look at the run's **ios** job to see whether the tag compiles.
- `.github/workflows/ios-build.yml` runs the same script on PRs that touch the iOS paths (plus the script and the workflow), and by hand from **Actions → iOS build check**, so a PR that breaks the iOS build shows it before merging. `test/release-plan.test.js` checks its paths match `APP_PATHS.ios`.
- The simulator app can't be installed on a device or uploaded.

### Signed builds for TestFlight (by hand)

The maintainer builds and uploads App Store builds on their own Mac; CI never signs or uploads iOS and holds no Apple credentials (decided for #34). It needs a paid Apple Developer account whose team owns the bundle id `dev.bluedog.kindlingcontrol` (don't change it), and Xcode signed in to that team (*Xcode → Settings → Accounts*).

1. Check out the release tag (`git checkout v0.3.0`), so the build matches public source (GPL boundary).
2. `APPLE_TEAM_ID=ABCDE12345 npm run release:ios -- v0.3.0 --signed`. The team id is on developer.apple.com → *Membership*; it can also go in the git-ignored `.env` as `APPLE_TEAM_ID=…`. Signing is automatic (`-allowProvisioningUpdates`): Xcode creates or fetches the distribution certificate and App Store profile itself, so no certificate or profile files are kept in the repo. The script archives, refuses an archive not signed by that team, exports with `method = app-store-connect`, and writes `out/kindling-control-<version>-ios.ipa`.
3. Upload the `.ipa` with Apple's **Transporter** app (or from *Xcode → Window → Organizer*), then add testers in App Store Connect → TestFlight. Paste `release-notes/<version>/ios.txt` as the "What to Test" / "What's New" text.

`CFBundleVersion` is the tag's `versionFromTag()` code, so it only goes up, and App Store Connect refuses a build number it has already seen: a re-upload of the same version needs a new tag (for example `v0.3.0-rc.2` → `v0.3.0`). Key-custody notes belong in the private repo.

## Secrets (repo Settings → Secrets and variables → Actions)

Everything works without secrets: Android ships a debug-signed APK, and desktop builds are unsigned. Add these to enable the rest:

| Secret | Used for |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Release keystore, base64-encoded (see below) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias in the keystore |
| `ANDROID_KEY_PASSWORD` | Key password |

**Website:** kindlingcontrol.app isn't part of app releases; it lives and deploys from [kindling-control-website](https://github.com/bluedog-consulting/kindling-control-website). The web app isn't published anywhere.

**Android keystore:** create it once and keep it safe. If you lose it, you can never ship an update to the same app on Google Play.

```sh
keytool -genkeypair -v -keystore kindling-control-release.keystore -alias kindling-control \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 kindling-control-release.keystore   # paste the output into ANDROID_KEYSTORE_BASE64
```

Without a keystore, CI builds `assembleDebug`. That APK installs by sideloading, but Google Play won't accept it, and you can't upgrade from it to a signed build without uninstalling first.

**Desktop code signing** (not configured yet): macOS needs a Developer ID certificate plus notarization (electron-builder's `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`). Windows needs a code-signing certificate. Until then, users see Gatekeeper/SmartScreen warnings; the release notes explain how to get past them.

## Building Android locally

`tools/release-android.sh` is the Android build: the `android` job in `release.yml` runs it too (`--skip-install --no-notes`, plus `--debug` when there are no signing secrets), so a local build and a CI build go through the same steps and the same signing checks. If the SDK platform is missing, the script installs it with `sdkmanager` on CI (`CI=true`); locally it stops and prints the `sdkmanager` command, because installing SDK packages is your call. Without a terminal (as in CI) the script doesn't prompt: `ANDROID_KEYSTORE_PASSWORD` must be set, and an unset key password means "same as the keystore". It needs JDK 21+ and the Android SDK platform named by `compileSdkVersion` in `android/variables.gradle`; it checks both and prints the fix. It finds the SDK through `ANDROID_HOME` / `ANDROID_SDK_ROOT`, then `sdk.dir` in `android/local.properties` (written by Android Studio), then Android Studio's default location on macOS (`~/Library/Android/sdk`) and Linux (`~/Android/Sdk`).

```sh
export ANDROID_KEYSTORE_FILE=~/keys/release.jks   # a .jks and a .keystore are the same thing
export ANDROID_KEY_ALIAS=kindling-control
npm run release:android -- v0.1.0                 # prompts (hidden) for the passwords unless
                                                  # ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD are set
npm run release:android -- v0.1.0 --debug         # no keystore: debug-signed APK, not for Google Play
```

Instead of exporting them each time, put the variables in a git-ignored `.env` at the repo root (shell syntax: `ANDROID_KEYSTORE_FILE=~/keys/release.jks`; quote values containing spaces or `$`). The script loads it, and anything already exported in your shell takes precedence. The file holds secrets, so never commit it (`.gitignore` covers `.env`).

**Rebuilding a version Play has already seen.** Google Play refuses an upload whose `versionCode` it has seen before, even for the same version name. Keep the tag and bump only the code: `npm run release:android -- v0.1.0 --version-code 10100`. The code must be higher than the tag's own (10099 for a final `v0.1.0`) and below the next version's. Codes between a final release and the next patch version (10100–10198 here) belong to that patch version's pre-releases (`v0.1.1-alpha.N`), so pick the lowest unused one. The output files are named `…-android-vc10100.aab` so they can't be confused with the CI build. CI never passes `--version-code`; it always derives the code from the tag.

The signed build leaves `kindling-control-<version>-android.apk` and `.aab` in `out/` and prints the certificate fingerprint to compare with Play Console (*App signing → Upload key*). It then checks the `.aab` really is signed, and by that keystore's key, and stops if not (`jarsigner -verify` alone reports success for an unsigned file). Passwords reach `keytool` through the environment, never on its command line. It also writes `kindling-control-<version>-android-whatsnew.txt` from `release-notes/<version>/android.txt` when that file exists (it warns if a final version has none; CI would stop). It builds your working tree, not the tag, and warns if `HEAD` isn't the tag. Add `--skip-install` to skip `npm ci`.

## Google Play listing

The store listing (descriptions, graphics, screenshots), the Play Console answers, and the key-custody and upload notes for the **official** app are kept in the maintainers' private repository, not here. This repository only contains what is needed to *build* the app. If you publish your own fork, write your own listing and choose your own name, icon and app ID (see [TRADEMARKS.md](../TRADEMARKS.md)). Google Play needs a signed `.aab`; build one with `npm run release:android` and your own keystore.

## Testing the plan locally

```sh
npm run release:plan -- v0.3.0 v0.2.0    # what would v0.3.0 build, compared with v0.2.0?
```
