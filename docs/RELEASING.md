# Releasing

Releases are cut by pushing a version tag. `.github/workflows/release.yml` then:

1. runs the tests
2. works out which apps changed since the previous `v*` tag (`tools/release-plan.js`)
3. builds only those apps
4. publishes one GitHub Release with the downloads and a table of what was built and why

```sh
git checkout main && git pull
# write release-notes/0.2.0/android.txt (and macos.txt), commit and push them (see "Store release notes")
git tag v0.2.0            # or v0.2.0-beta.1 for a pre-release
git push origin v0.2.0
```

Watch it under **Actions → Release**. To rebuild an existing tag, for example after adding secrets, run the workflow manually (*Run workflow*), give it the tag, and tick **force** to build every app.

## Versions

- Tags must be semantic versions: `vMAJOR.MINOR.PATCH`, optionally `-alpha.N`, `-beta.N` or `-rc.N`. Minor and patch go up to 99; pre-release numbers up to 32.
- The version comes from the tag. You don't need to bump `package.json` by hand; CI sets it at build time.
- Android needs an increasing integer `versionCode`, derived as `major·1 000 000 + minor·10 000 + patch·100 + suffix`. The suffix is alpha 0–32, beta 33–65, rc 66–98, and 99 for a final release. So `1.2.3-beta.1` (1020334) < `1.2.3-rc.1` (1020367) < `1.2.3` (1020399), and phones accept every upgrade.
- A tag with a `-` suffix is published as a GitHub **pre-release**.

## Store release notes

The "What's new" text for the store listings is versioned with the release. It lives in `release-notes/<version>/` (the tag without the `v`), one plain-text file per store:

| File | Store | Limit |
|---|---|---|
| `android.txt` | Google Play, "What's new" | 500 characters |
| `macos.txt` | Mac App Store, "What's New in This Version" | 4000 characters |

Commit them before you tag, so `v0.2.0` ships exactly `release-notes/0.2.0/`. Details and an example layout are in [release-notes/README.md](../release-notes/README.md).

- The `plan` job runs `tools/release-notes.js` first. A **final** tag that builds Android fails right away if `android.txt` is missing, empty or over the limit, before anything is built. Pre-release tags need no notes.
- `macos.txt` is optional, because macOS isn't built in CI. If it exists it is validated like the others.
- The `release` job checks out the tag, appends a **Store release notes** section to the GitHub Release body, and attaches `kindling-control-<version>-android-whatsnew.txt` / `…-macos-whatsnew.txt`, ready to paste into Play Console or App Store Connect. Nothing is uploaded to a store automatically yet.
- Check ahead of time: `npm run release:notes -- v0.2.0 --require android`.

## What gets built

| App | Rebuilt when these change | Output |
|---|---|---|
| Android | `src/`, `android/`, `capacitor.config.json`, `package.json`, `package-lock.json` | `…-android.apk` + `.aab` (signed), or `…-android-debug.apk` |
| Desktop | `src/`, `desktop/`, `build/` (icons), `package.json`, `package-lock.json` | Windows `.exe` (NSIS), Linux `.AppImage` + `.deb` |

- Changes that only touch docs, tests, tools or `ios/` build nothing.
- An app that is skipped keeps its downloads on the earlier release, and the release notes say so.
- The first tag (no earlier `v*` tag) builds everything.

**macOS** isn't in the pipeline yet either: its build doesn't work in CI so far, so it was taken out of the desktop matrix in `release.yml` to keep it from blocking releases (any failed build skips publishing). Build the `.dmg` locally with `npm run desktop:dist` on a Mac (see [APPS.md](APPS.md)), and add the `macos-latest` row back once it builds.

**iOS** isn't in the pipeline yet. It needs a macOS runner, an Apple Developer account and signing certificates. Build it locally for now (see [APPS.md](APPS.md)).

## Secrets (repo Settings → Secrets and variables → Actions)

Everything works without secrets: Android ships a debug-signed APK, and desktop builds are unsigned. Add these to enable the rest:

| Secret | Used for |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Release keystore, base64-encoded (see below) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias in the keystore |
| `ANDROID_KEY_PASSWORD` | Key password |

**Website:** kindlingspark.app isn't part of app releases; it lives and deploys from [kindling-control-website](https://github.com/bluedog-consulting/kindling-control-website). The web app isn't published anywhere.

**Android keystore:** create it once and keep it safe. If you lose it, you can never ship an update to the same app on Google Play.

```sh
keytool -genkeypair -v -keystore kindling-control-release.keystore -alias kindling-control \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 kindling-control-release.keystore   # paste the output into ANDROID_KEYSTORE_BASE64
```

Without a keystore, CI builds `assembleDebug`. That APK installs by sideloading, but Google Play won't accept it, and you can't upgrade from it to a signed build without uninstalling first.

**Desktop code signing** (not configured yet): macOS needs a Developer ID certificate plus notarization (electron-builder's `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`). Windows needs a code-signing certificate. Until then, users see Gatekeeper/SmartScreen warnings; the release notes explain how to get past them.

## Building Android locally

`tools/release-android.sh` does what the `android` job in `release.yml` does, on your machine. It needs JDK 21+ and the Android SDK platform named by `compileSdkVersion` in `android/variables.gradle`; it checks both and prints the fix.

```sh
export ANDROID_KEYSTORE_FILE=~/keys/release.jks   # a .jks and a .keystore are the same thing
export ANDROID_KEY_ALIAS=kindling-control
npm run release:android -- v0.1.0                 # prompts (hidden) for the passwords unless
                                                  # ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD are set
npm run release:android -- v0.1.0 --debug         # no keystore: debug-signed APK, not for Google Play
```

Instead of exporting them each time, put the variables in a git-ignored `.env` at the repo root (shell syntax: `ANDROID_KEYSTORE_FILE=~/keys/release.jks`; quote values containing spaces or `$`). The script loads it, and anything already exported in your shell takes precedence. The file holds secrets, so never commit it (`.gitignore` covers `.env`).

**Rebuilding a version Play has already seen.** Google Play refuses an upload whose `versionCode` it has seen before, even for the same version name. Keep the tag and bump only the code: `npm run release:android -- v0.1.0 --version-code 10100`. The code must be higher than the tag's own (10099 for a final `v0.1.0`) and below the next version's. Codes between a final release and the next patch version (10100–10198 here) belong to that patch version's pre-releases (`v0.1.1-alpha.N`), so pick the lowest unused one. The output files are named `…-android-vc10100.aab` so they can't be confused with the CI build. This works only in the local script; the CI workflow still derives the code from the tag.

The signed build leaves `kindling-control-<version>-android.apk` and `.aab` in `out/` and prints the certificate fingerprint to compare with Play Console (*App signing → Upload key*). It then checks the `.aab` really is signed, and by that keystore's key, and stops if not (`jarsigner -verify` alone reports success for an unsigned file). Passwords reach `keytool` through the environment, never on its command line. It also writes `kindling-control-<version>-android-whatsnew.txt` from `release-notes/<version>/android.txt` when that file exists (it warns if a final version has none; CI would stop). It builds your working tree, not the tag, and warns if `HEAD` isn't the tag. Add `--skip-install` to skip `npm ci`.

## Google Play listing

The store listing (descriptions, graphics, screenshots), the Play Console answers, and the key-custody and upload notes for the **official** app are kept in the maintainers' private repository, not here. This repository only contains what is needed to *build* the app. If you publish your own fork, write your own listing and choose your own name, icon and app ID (see [TRADEMARKS.md](../TRADEMARKS.md)). Google Play needs a signed `.aab`; build one with `npm run release:android` and your own keystore.

## Testing the plan locally

```sh
npm run release:plan -- v0.3.0 v0.2.0    # what would v0.3.0 build, compared with v0.2.0?
```
