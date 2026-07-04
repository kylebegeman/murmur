#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "${1:-}" != "run" ]]; then
  exec cargo "$@"
fi

shift

cargo_args=()
app_args=()
parsing_app_args=0

for arg in "$@"; do
  if [[ "$arg" == "--" && "$parsing_app_args" -eq 0 ]]; then
    parsing_app_args=1
    continue
  fi

  if [[ "$parsing_app_args" -eq 0 ]]; then
    cargo_args+=("$arg")
  else
    app_args+=("$arg")
  fi
done

build_args=("build")
profile="debug"
target_triple=""
has_bin=0
expecting_target=0
expecting_bin=0

for arg in "${cargo_args[@]}"; do
  build_args+=("$arg")

  if [[ "$expecting_target" -eq 1 ]]; then
    target_triple="$arg"
    expecting_target=0
    continue
  fi

  if [[ "$expecting_bin" -eq 1 ]]; then
    has_bin=1
    expecting_bin=0
    continue
  fi

  case "$arg" in
    --release)
      profile="release"
      ;;
    --target)
      expecting_target=1
      ;;
    --target=*)
      target_triple="${arg#--target=}"
      ;;
    --bin)
      expecting_bin=1
      ;;
    --bin=*)
      has_bin=1
      ;;
  esac
done

if [[ "$has_bin" -eq 0 ]]; then
  build_args+=("--bin" "murmur")
fi

if [[ -n "$target_triple" ]]; then
  target_base="target/$target_triple/$profile"
else
  target_base="target/$profile"
fi

src_tauri_dir="$(pwd)"
binary_path="$src_tauri_dir/$target_base/murmur"
app_dir="$src_tauri_dir/$target_base/dev-bundle/Murmur.app"
contents_dir="$app_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"

stop_running_dev_app() {
  local binary_pattern="$app_dir/Contents/MacOS/murmur"

  if pgrep -f "$binary_pattern" >/dev/null 2>&1; then
    echo "Stopping existing Murmur dev app..."
    pkill -TERM -f "$binary_pattern" 2>/dev/null || true

    for _ in {1..25}; do
      if ! pgrep -f "$binary_pattern" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done

    pkill -KILL -f "$binary_pattern" 2>/dev/null || true
  fi

  pkill -f "/usr/bin/open .*${app_dir}" 2>/dev/null || true
}

list_codesign_identities() {
  if [[ -n "${MURMUR_CODESIGN_IDENTITY:-}" ]]; then
    printf '%s\n' "$MURMUR_CODESIGN_IDENTITY"
    return
  fi

  {
    security find-identity -v -p codesigning 2>/dev/null \
      | awk -F '"' '/Developer ID Application:/ { print $2 }'
    security find-identity -v -p codesigning 2>/dev/null \
      | awk -F '"' '/Apple Development:/ { print $2 }'
  } | awk 'NF && !seen[$0]++'
}

sign_with_identity() {
  local identity="$1"
  local err_log="${TMPDIR:-/tmp}/murmur-codesign.err"
  local codesign_args=(
    --force
    --timestamp=none
    --options
    runtime
    --entitlements
    Entitlements.plist
  )

  : > "$err_log"

  codesign "${codesign_args[@]}" --sign "$identity" "$macos_dir/murmur" >/dev/null 2>>"$err_log" \
    && codesign "${codesign_args[@]}" --deep --sign "$identity" "$app_dir" >/dev/null 2>>"$err_log"
}

sign_app_bundle() {
  local identity=""
  local selected_identity=""

  while IFS= read -r identity; do
    if [[ -z "$identity" ]]; then
      continue
    fi

    echo "Signing bundled macOS dev app with identity: $identity"
    if sign_with_identity "$identity"; then
      selected_identity="$identity"
      break
    fi

    echo "Code signing failed with identity: $identity" >&2
  done < <(list_codesign_identities)

  if [[ -z "$selected_identity" ]]; then
    if [[ "${MURMUR_ALLOW_ADHOC_CODESIGN:-}" == "1" ]]; then
      echo "WARNING: Falling back to ad-hoc signing. macOS Accessibility trust will not survive rebuilds." >&2
      sign_with_identity "-"
      selected_identity="-"
    else
      cat >&2 <<'EOF'
No certificate-backed macOS code signing identity worked.

Accessibility trust is keyed to the bundle identifier and code-signing requirement.
Ad-hoc signing would recreate the broken cdhash-only requirement, so this runner
will not fall back to it unless MURMUR_ALLOW_ADHOC_CODESIGN=1 is set.

Install an Apple Development or Developer ID Application certificate, or set
MURMUR_CODESIGN_IDENTITY to a specific identity from:

  security find-identity -v -p codesigning
EOF
      exit 1
    fi
  fi

  echo "Signed bundled macOS dev app with: $selected_identity"
}

stop_running_dev_app
cargo "${build_args[@]}"

if [[ ! -x "$binary_path" ]]; then
  echo "Expected built binary at $binary_path, but it was not found." >&2
  exit 1
fi

rm -rf "$app_dir"
mkdir -p "$macos_dir" "$resources_dir/resources"

cp "$binary_path" "$macos_dir/murmur"
cp "icons/icon.icns" "$resources_dir/icon.icns"
rsync -a --delete "resources/" "$resources_dir/resources/"

cat > "$contents_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>English</string>
  <key>CFBundleDisplayName</key>
  <string>Murmur</string>
  <key>CFBundleExecutable</key>
  <string>murmur</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.kylebegeman.murmur</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Murmur</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.9.0</string>
  <key>CFBundleVersion</key>
  <string>0.9.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Request microphone access to transcribe audio locally</string>
</dict>
</plist>
PLIST

xattr -dr com.apple.quarantine "$app_dir" 2>/dev/null || true

sign_app_bundle

lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$lsregister" ]]; then
  "$lsregister" -f "$app_dir" 2>/dev/null || true
fi

echo "Launching bundled macOS dev app: $app_dir"
log_dir="${TMPDIR:-/tmp}/murmur-dev"
mkdir -p "$log_dir"
stdout_log="$log_dir/murmur.out.log"
stderr_log="$log_dir/murmur.err.log"
: > "$stdout_log"
: > "$stderr_log"
echo "Bundled app logs: $stdout_log $stderr_log"

if [[ "${#app_args[@]}" -gt 0 ]]; then
  exec env -u __CFBundleIdentifier -u XPC_SERVICE_NAME -u XPC_FLAGS \
    /usr/bin/open -n -W -o "$stdout_log" --stderr "$stderr_log" "$app_dir" --args "${app_args[@]}"
fi

exec env -u __CFBundleIdentifier -u XPC_SERVICE_NAME -u XPC_FLAGS \
  /usr/bin/open -n -W -o "$stdout_log" --stderr "$stderr_log" "$app_dir"
