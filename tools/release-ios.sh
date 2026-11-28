#!/usr/bin/env bash
# Builds the iOS app (iPhone + iPad). The `ios` job in .github/workflows/release.yml and the PR check in
# .github/workflows/ios-build.yml run this same script, so a local build and a CI build go through one path.
#
#   npm run release:ios -- [vX.Y.Z] [--skip-install]
#
# Today it makes an UNSIGNED build for the iOS Simulator. That proves the project compiles from a clean
# checkout without any Apple account or secrets; it can't be installed on a device or uploaded. Signed
# archives for TestFlight / the App Store are #34 and will be added here, not in the workflow.
#
# Version: CFBundleShortVersionString is MAJOR.MINOR.PATCH from the tag (Apple allows only numbers), and
# CFBundleVersion is the same strictly increasing code as Android's versionCode (versionFromTag()).
# Needs macOS with Xcode. Output goes to out/ (git-ignored). Builds the files in your working tree, not the tag.
set -euo pipefail
cd "$(dirname "$0")/.."

tag=''
install=true
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-install) install=false ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) tag="$1" ;;
  esac
  shift
done
tag="${tag:-$(git describe --tags --abbrev=0 --match 'v[0-9]*')}"

read -r version code marketing < <(node --input-type=module -e "
  import { versionFromTag } from './tools/release-plan.js';
  const v = versionFromTag(process.argv[1]);
  console.log(v.name, v.code, v.name.split('-')[0]);
" "$tag")
echo "Building iOS $tag (version $version, CFBundleShortVersionString $marketing, CFBundleVersion $code)"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$tag^{commit}" 2>/dev/null || true)" ]; then
  echo "warning: HEAD is not $tag; this builds your current working tree." >&2
fi

if ! command -v xcodebuild >/dev/null; then
  echo "error: xcodebuild not found. Building the iOS app needs macOS with Xcode (see docs/APPS.md)." >&2
  exit 1
fi
xcodebuild -version

if $install; then npm ci; fi
# Stamp the version into the web app (src/version.js; used by the anonymous error reports) for the synced copy
# only, then put the committed file back so a local build leaves the working tree clean.
backup="${TMPDIR:-/tmp}/kindling-version-ios.js.bak"
cp src/version.js "$backup"
trap 'cp "$backup" src/version.js' EXIT
node tools/stamp-version.js "$version"
npx cap sync ios
cp "$backup" src/version.js

derived=out/ios-derived
rm -rf "$derived"
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO \
  MARKETING_VERSION="$marketing" \
  CURRENT_PROJECT_VERSION="$code" \
  build

app=$(find "$derived/Build/Products" -maxdepth 2 -name 'App.app' -type d | head -n 1)
if [ -z "$app" ]; then
  echo "error: the build finished but no App.app was produced." >&2
  exit 1
fi
plist="$app/Info.plist"
got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")
if [ "$got" != "$code" ]; then
  echo "error: built app has CFBundleVersion $got, expected $code." >&2
  exit 1
fi
mkdir -p out
zip="out/kindling-control-$version-ios-simulator.zip"
rm -f "$zip"
(cd "$(dirname "$app")" && ditto -c -k --keepParent App.app "$OLDPWD/$zip")
ls -l "$zip"
