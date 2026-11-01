# Releasing

Releases are cut by pushing a version tag. `.github/workflows/release.yml` then:

1. runs the tests
2. works out which apps changed since the previous `v*` tag (`tools/release-plan.js`)
3. builds only those apps
4. publishes one GitHub Release with the downloads and a table of what was built and why

```sh
git checkout main && git pull
git tag v0.2.0            # or v0.2.0-beta.1 for a pre-release
git push origin v0.2.0
```

Watch it under **Actions → Release**. To rebuild an existing tag, for example after adding secrets, run the workflow manually (*Run workflow*), give it the tag, and tick **force** to build every app.

## Versions

- Tags must be semantic versions: `vMAJOR.MINOR.PATCH`, optionally `-alpha.N`, `-beta.N` or `-rc.N`. Minor and patch go up to 99; pre-release numbers up to 32.
- The version comes from the tag. You don't need to bump `package.json` by hand; CI sets it at build time.
- Android needs an increasing integer `versionCode`, derived as `major·1 000 000 + minor·10 000 + patch·100 + suffix`. The suffix is alpha 0–32, beta 33–65, rc 66–98, and 99 for a final release. So `1.2.3-beta.1` (1020334) < `1.2.3-rc.1` (1020367) < `1.2.3` (1020399), and phones accept every upgrade.
- A tag with a `-` suffix is published as a GitHub **pre-release**.

## What gets built

| App | Rebuilt when these change | Output |
|---|---|---|
| Android | `src/`, `android/`, `capacitor.config.json`, `package.json`, `package-lock.json` | `…-android.apk` + `.aab` (signed), or `…-android-debug.apk` |
| Desktop | `src/`, `desktop/`, `build/` (icons), `package.json`, `package-lock.json` | Windows `.exe` (NSIS), macOS `.dmg` (arm64 + x64), Linux `.AppImage` + `.deb` |

- Changes that only touch docs, tests, tools or `ios/` build nothing.
- An app that is skipped keeps its downloads on the earlier release, and the release notes say so.
- The first tag (no earlier `v*` tag) builds everything.

**iOS** isn't in the pipeline yet. It needs a macOS runner, an Apple Developer account and signing certificates. Build it locally for now (see [APPS.md](APPS.md)).

## Secrets (repo Settings → Secrets and variables → Actions)

Everything works without secrets: Android ships a debug-signed APK, and desktop builds are unsigned. Add these to enable the rest:

| Secret | Used for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploying the website (`site.yml`, not releases). Permissions are listed in [PRESETS.md](PRESETS.md). |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account to deploy to |
| `ANDROID_KEYSTORE_BASE64` | Release keystore, base64-encoded (see below) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias in the keystore |
| `ANDROID_KEY_PASSWORD` | Key password |

**Website:** kindlingspark.app isn't part of releases, and the web app isn't published at all. `.github/workflows/site.yml` deploys the landing page, guide and presets hub on pushes to `main` (see [PRESETS.md](PRESETS.md)). Wrangler is pinned there (`wrangler@4.151.3`).

**Android keystore:** create it once and keep it safe. If you lose it, you can never ship an update to the same app on Google Play.

```sh
keytool -genkeypair -v -keystore kindling-control-release.keystore -alias kindling-control \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 kindling-control-release.keystore   # paste the output into ANDROID_KEYSTORE_BASE64
```

Without a keystore, CI builds `assembleDebug`. That APK installs by sideloading, but Google Play won't accept it, and you can't upgrade from it to a signed build without uninstalling first.

**Desktop code signing** (not configured yet): macOS needs a Developer ID certificate plus notarization (electron-builder's `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`). Windows needs a code-signing certificate. Until then, users see Gatekeeper/SmartScreen warnings; the release notes explain how to get past them.

## Testing the plan locally

```sh
npm run release:plan -- v0.3.0 v0.2.0    # what would v0.3.0 build, compared with v0.2.0?
```
