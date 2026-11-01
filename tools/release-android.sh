#!/usr/bin/env bash
# Builds the Android release locally, the same way the `android` job in
# .github/workflows/release.yml does.
#
#   npm run release:android -- [vX.Y.Z] [--debug] [--skip-install] [--version-code N]
#
# Signed build (apk + aab for Google Play) needs your keystore:
#   ANDROID_KEYSTORE_FILE=~/keys/release.jks ANDROID_KEY_ALIAS=kindling-control npm run release:android
# Passwords are read from ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD, or prompted for (hidden).
# All four ANDROID_* variables can go in a git-ignored .env at the repo root (see the .env note below).
# --debug builds a debug-signed APK instead (sideloading only; Google Play rejects it).
# --version-code N keeps the version name but uses N as the Android versionCode. Google Play refuses an upload
#   whose versionCode it has already seen, so use it to rebuild a version you already uploaded. N must be higher
#   than the tag's own code, and the output files get a -vcN suffix so they can't be mistaken for the CI build.
# Output goes to out/ (git-ignored). Builds the files in your working tree, not the tag.
set -euo pipefail
cd "$(dirname "$0")/.."

# Signing settings can live in a git-ignored .env (shell syntax: KEY=value, quote values with spaces or $).
# Variables already set in your shell win over the file.
if [ -f .env ]; then
  while IFS= read -r name; do
    [ -n "${!name+x}" ] && preset+=("$name=${!name}")
  done < <(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' .env)
  set -a; . ./.env; set +a
  for kv in ${preset[@]+"${preset[@]}"}; do export "${kv%%=*}=${kv#*=}"; done
fi

tag=''
debug=false
install=true
override=''
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) debug=true ;;
    --skip-install) install=false ;;
    --version-code) override="${2:-}"; [ $# -ge 2 ] || { echo "--version-code needs a number" >&2; exit 2; }; shift ;;
    --version-code=*) override="${1#*=}" ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) tag="$1" ;;
  esac
  shift
done
tag="${tag:-$(git describe --tags --abbrev=0 --match 'v[0-9]*')}"

# Version name + versionCode come from the same code CI uses.
read -r version code < <(node --input-type=module -e "
  import { versionFromTag } from './tools/release-plan.js';
  const v = versionFromTag(process.argv[1]);
  console.log(v.name, v.code);
" "$tag")
suffix=''
if [ -n "$override" ]; then
  case "$override" in ''|*[!0-9]*) echo "error: --version-code must be a whole number, got '$override'." >&2; exit 2 ;; esac
  if [ "$override" -le "$code" ] || [ "$override" -gt 2100000000 ]; then
    echo "error: --version-code must be higher than $code (the code $tag gets by default) and at most 2100000000." >&2
    exit 2
  fi
  echo "Overriding versionCode $code with $override (Play needs a new code for every upload)."
  code="$override"
  suffix="-vc$code"
fi
echo "Building $tag (version $version, versionCode $code)"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$tag^{commit}" 2>/dev/null || true)" ]; then
  echo "warning: HEAD is not $tag; this builds your current working tree." >&2
fi

# Preflight: fail early with the fix, rather than deep inside Gradle.
java_major() { "$1" -version 2>&1 | sed -n '1s/.*version "\([0-9]*\).*/\1/p'; }
current="${JAVA_HOME:+$JAVA_HOME/bin/}java"
if [ "$(java_major "$current")" -lt 21 ] 2>/dev/null || ! command -v "$current" >/dev/null; then
  # A JAVA_HOME or PATH pointing at an older JDK wins over a newer one that is installed. On macOS, ask for a 21+.
  if [ -x /usr/libexec/java_home ] && jdk=$(/usr/libexec/java_home -v 21+ 2>/dev/null); then
    export JAVA_HOME="$jdk"
    export PATH="$JAVA_HOME/bin:$PATH"
    echo "Using JDK at $JAVA_HOME"
  else
    echo "error: JDK 21 or newer is needed (found $(java_major "$current" || echo none)). Install one, e.g. 'brew install --cask temurin@21'." >&2
    exit 1
  fi
fi
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
compile_sdk=$(sed -n 's/.*compileSdkVersion = \([0-9]*\).*/\1/p' android/variables.gradle)
if [ ! -d "$sdk/platforms/android-$compile_sdk" ]; then
  echo "error: Android SDK platform $compile_sdk not found in $sdk." >&2
  echo "  Install it: \"$sdk/cmdline-tools/latest/bin/sdkmanager\" \"platforms;android-$compile_sdk\" (or via Android Studio)." >&2
  exit 1
fi
export ANDROID_HOME="$sdk"

signed=false
if ! $debug; then
  : "${ANDROID_KEYSTORE_FILE:?set ANDROID_KEYSTORE_FILE to your .jks/.keystore (or pass --debug)}"
  ANDROID_KEYSTORE_FILE="${ANDROID_KEYSTORE_FILE/#\~/$HOME}"
  [ -f "$ANDROID_KEYSTORE_FILE" ] || { echo "error: keystore not found: $ANDROID_KEYSTORE_FILE" >&2; exit 1; }
  # Gradle runs from android/, so a path relative to the repo root would not resolve there and the build
  # would quietly come out unsigned. Hand it an absolute path.
  ANDROID_KEYSTORE_FILE="$(cd "$(dirname "$ANDROID_KEYSTORE_FILE")" && pwd)/$(basename "$ANDROID_KEYSTORE_FILE")"
  : "${ANDROID_KEY_ALIAS:?set ANDROID_KEY_ALIAS (list aliases: keytool -list -keystore \"\$ANDROID_KEYSTORE_FILE\")}"
  if [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then read -r -s -p 'Keystore password: ' ANDROID_KEYSTORE_PASSWORD; echo; fi
  if [ -z "${ANDROID_KEY_PASSWORD:-}" ]; then read -r -s -p 'Key password (Enter = same as keystore): ' ANDROID_KEY_PASSWORD; echo; fi
  export ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS
  export ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"
  signed=true
fi

if $install; then npm ci; fi
npx cap sync android

mkdir -p out
props=(-PversionName="$version" -PversionCode="$code")
(
  cd android
  if $signed; then
    ./gradlew --no-daemon assembleRelease bundleRelease "${props[@]}"
  else
    ./gradlew --no-daemon assembleDebug "${props[@]}"
  fi
)

if $signed; then
  if [ ! -f android/app/build/outputs/apk/release/app-release.apk ]; then
    echo "error: Gradle did not sign the release build (it produced app-release-unsigned.apk)." >&2
    echo "  Check ANDROID_KEYSTORE_FILE ($ANDROID_KEYSTORE_FILE) and the alias/passwords." >&2
    exit 1
  fi
  cp android/app/build/outputs/apk/release/app-release.apk "out/kindling-control-$version-android$suffix.apk"
  cp android/app/build/outputs/bundle/release/app-release.aab "out/kindling-control-$version-android$suffix.aab"
  echo
  echo "Signing certificate (compare with Play Console > App signing > Upload key):"
  keytool -list -v -keystore "$ANDROID_KEYSTORE_FILE" -alias "$ANDROID_KEY_ALIAS" -storepass "$ANDROID_KEYSTORE_PASSWORD" \
    | grep -E 'SHA-?(1|256):' || true
  jarsigner -verify "out/kindling-control-$version-android$suffix.aab" | head -1
else
  cp android/app/build/outputs/apk/debug/app-debug.apk "out/kindling-control-$version-android-debug$suffix.apk"
  echo "Debug-signed APK only; Google Play will not accept it."
fi
# Play "What's new" text from release-notes/<version>/android.txt, as the publish job does in CI.
# CI refuses to release a final version without it; locally this only warns, so test builds still work.
require=()
case "$version" in *-*) ;; *) require=(--require android) ;; esac
echo
if ! node tools/release-notes.js "$tag" --out out ${require[@]+"${require[@]}"}; then
  echo "warning: no valid Play release notes, so no whatsnew file was written (CI would stop here for a final tag)." >&2
  echo "  Create release-notes/$version/android.txt (500 characters at most; see release-notes/README.md)." >&2
fi
echo
ls -l out/kindling-control-"$version"-android*
