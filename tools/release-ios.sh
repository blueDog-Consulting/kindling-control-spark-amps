#!/usr/bin/env bash
# Builds the iOS app (iPhone + iPad). The `ios` job in .github/workflows/release.yml and the PR check in
# .github/workflows/ios-build.yml run this same script, so a local build and a CI build go through one path.
#
#   npm run release:ios -- [vX.Y.Z] [--skip-install] [--signed]
#
# By default it makes an UNSIGNED build for the iOS Simulator. That proves the project compiles from a clean
# checkout without any Apple account or secrets; it can't be installed on a device or uploaded. CI runs this.
#
# --signed (#34) makes the App Store build on a maintainer's Mac: an archive signed with the Apple Developer
# team in APPLE_TEAM_ID (environment or the git-ignored .env), exported as out/kindling-control-<version>-ios.ipa.
# Signing is automatic: Xcode must be signed in to that team (Xcode > Settings > Accounts), and it fetches the
# distribution certificate and profile for dev.bluedog.kindlingcontrol. Upload the .ipa by hand with
# Transporter or Xcode's Organizer (docs/RELEASING.md). Nothing here uploads, and CI never passes --signed.
#
# Version: CFBundleShortVersionString is MAJOR.MINOR.PATCH from the tag (Apple allows only numbers), and
# CFBundleVersion is the same strictly increasing code as Android's versionCode (versionFromTag()).
# Needs macOS with Xcode. Output goes to out/ (git-ignored). Builds the files in your working tree, not the tag.
set -euo pipefail
cd "$(dirname "$0")/.."

# APPLE_TEAM_ID can live in a git-ignored .env (KEY=value); a value already set in your shell wins.
if [ -f .env ] && [ -z "${APPLE_TEAM_ID:-}" ]; then
  APPLE_TEAM_ID=$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}APPLE_TEAM_ID=["'"'"']\{0,1\}\([A-Z0-9]*\).*/\2/p' .env | tail -n 1)
fi

tag=''
install=true
signed=false
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-install) install=false ;;
    --signed) signed=true ;;
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
if $signed; then
  case "${APPLE_TEAM_ID:-}" in
    [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]) ;;
    *) echo "error: --signed needs APPLE_TEAM_ID, your 10-character Apple Developer team id (developer.apple.com > Membership), in the environment or .env." >&2; exit 1 ;;
  esac
fi

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
mkdir -p out

if $signed; then
  archive="$derived/KindlingControl.xcarchive"
  xcodebuild \
    -project ios/App/App.xcodeproj \
    -scheme App \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "$derived" \
    -archivePath "$archive" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    MARKETING_VERSION="$marketing" \
    CURRENT_PROJECT_VERSION="$code" \
    archive
  app="$archive/Products/Applications/App.app"
  got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")
  [ "$got" = "$code" ] || { echo "error: archived app has CFBundleVersion $got, expected $code." >&2; exit 1; }
  # Refuse to hand over an archive that isn't signed by the requested team.
  team=$(codesign -dv --verbose=2 "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  if [ "$team" != "$APPLE_TEAM_ID" ]; then
    echo "error: the archive is signed by team '${team:-none}', not $APPLE_TEAM_ID." >&2
    exit 1
  fi
  options="$derived/ExportOptions.plist"
  cat > "$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
  xcodebuild -exportArchive -archivePath "$archive" -exportPath "$derived/export" \
    -exportOptionsPlist "$options" -allowProvisioningUpdates
  ipa=$(find "$derived/export" -maxdepth 1 -name '*.ipa' | head -n 1)
  [ -n "$ipa" ] || { echo "error: the export finished but produced no .ipa." >&2; exit 1; }
  cp "$ipa" "out/kindling-control-$version-ios.ipa"
  ls -l "out/kindling-control-$version-ios.ipa"
  echo "Upload it with Transporter (or Xcode > Window > Organizer, from $archive). See docs/RELEASING.md."
  exit 0
fi

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
zip="out/kindling-control-$version-ios-simulator.zip"
rm -f "$zip"
(cd "$(dirname "$app")" && ditto -c -k --keepParent App.app "$OLDPWD/$zip")
ls -l "$zip"
