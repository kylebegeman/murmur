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

cargo "${build_args[@]}"

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

codesign --force --sign - --options runtime --entitlements Entitlements.plist "$macos_dir/murmur" >/dev/null
codesign --force --deep --sign - --options runtime --entitlements Entitlements.plist "$app_dir" >/dev/null

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
