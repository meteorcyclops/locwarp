#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
venv_dir="$repo_dir/.venv"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This build script must run on macOS." >&2
  exit 1
fi

# Homebrew Node can temporarily become unloadable after a dependent library
# upgrade. Prefer it when healthy, otherwise fall back to the newest working
# NVM runtime so a local release build stays reproducible.
if ! node --version >/dev/null 2>&1; then
  nvm_node_dir=""
  for node_candidate in "${HOME}/.nvm/versions/node"/*/bin/node; do
    if [ -x "$node_candidate" ] && "$node_candidate" --version >/dev/null 2>&1; then
      nvm_node_dir=$(dirname "$node_candidate")
    fi
  done
  if [ -n "$nvm_node_dir" ]; then
    PATH="$nvm_node_dir:$PATH"
    export PATH
  fi
fi

node --version >/dev/null
npm --version >/dev/null

# Screen Recording consent is tied to the app's designated code requirement.
# An ad-hoc signature reduces that requirement to the build-specific CDHash,
# which makes every rebuild look like a different app to macOS TCC. Require a
# stable Apple signing identity for local macOS builds so permission survives
# upgrades. Developers can select a different valid identity explicitly.
macos_signing_identity="${MACOS_SIGNING_IDENTITY:-}"
if [ -z "$macos_signing_identity" ]; then
  macos_signing_identity=$(
    security find-identity -v -p codesigning 2>/dev/null |
      awk -F '"' '/"Apple Development:/{ print $2; exit }'
  )
fi
if [ -z "$macos_signing_identity" ]; then
  echo "A stable Apple Development signing identity is required." >&2
  echo "Install one in Keychain or set MACOS_SIGNING_IDENTITY explicitly." >&2
  exit 1
fi
echo "Using macOS signing identity: $macos_signing_identity"

# Build the local-only ScreenCaptureKit + Vision OCR helper before invoking
# electron-builder. It is shipped as an extraResource so Electron can spawn it
# without putting capture code in the renderer or Node main process.
helper_source="$repo_dir/macos/locwarp-ocr-helper/main.swift"
helper_info_plist="$repo_dir/macos/locwarp-ocr-helper/Info.plist"
helper_output_dir="$repo_dir/dist-macos"
macos_arch="${MACOS_ARCH:-arm64}"

case "$macos_arch" in
  arm64|x86_64)
    helper_target="${macos_arch}-apple-macosx12.3"
    mkdir -p "$helper_output_dir"
    xcrun swiftc "$helper_source" -O -whole-module-optimization \
      -target "$helper_target" \
      -framework AppKit \
      -framework CoreGraphics \
      -framework CoreMedia \
      -framework ImageIO \
      -framework ScreenCaptureKit \
      -framework Vision \
      -Xlinker -sectcreate \
      -Xlinker __TEXT \
      -Xlinker __info_plist \
      -Xlinker "$helper_info_plist" \
      -o "$helper_output_dir/locwarp-ocr-helper"
    chmod 755 "$helper_output_dir/locwarp-ocr-helper"
    ;;
  universal)
    mkdir -p "$helper_output_dir"
    for helper_arch in arm64 x86_64; do
      xcrun swiftc "$helper_source" -O -whole-module-optimization \
        -target "${helper_arch}-apple-macosx12.3" \
        -framework AppKit \
        -framework CoreGraphics \
        -framework CoreMedia \
        -framework ImageIO \
        -framework ScreenCaptureKit \
        -framework Vision \
        -Xlinker -sectcreate \
        -Xlinker __TEXT \
        -Xlinker __info_plist \
        -Xlinker "$helper_info_plist" \
        -o "$helper_output_dir/locwarp-ocr-helper-$helper_arch"
    done
    lipo -create \
      "$helper_output_dir/locwarp-ocr-helper-arm64" \
      "$helper_output_dir/locwarp-ocr-helper-x86_64" \
      -output "$helper_output_dir/locwarp-ocr-helper"
    chmod 755 "$helper_output_dir/locwarp-ocr-helper"
    ;;
  *)
    echo "MACOS_ARCH must be arm64, x86_64, or universal (got $macos_arch)." >&2
    exit 1
    ;;
esac

# Sign the standalone capture helper before it is copied into the app. Giving
# it a stable identifier and the same Team ID as the outer app avoids a second
# build-specific identity at the actual ScreenCaptureKit call site.
codesign --force \
  --options runtime \
  --timestamp=none \
  --identifier com.locwarp.ocr-helper \
  --sign "$macos_signing_identity" \
  "$helper_output_dir/locwarp-ocr-helper"
codesign --verify --strict "$helper_output_dir/locwarp-ocr-helper"

python3 -m venv "$venv_dir"
"$venv_dir/bin/python" -m pip install -r "$repo_dir/backend/requirements.txt" "pyinstaller==6.21.0"

"$venv_dir/bin/python" - <<'PY'
import importlib.metadata
import importlib.util

version = importlib.metadata.version("pymobiledevice3")
if version != "10.3.0":
    raise SystemExit(f"expected pymobiledevice3 10.3.0, got {version}")
if importlib.util.find_spec("pymobiledevice3.remote.userspace_tunnel") is None:
    raise SystemExit("pymobiledevice3 userspace_tunnel module is missing")
print(f"Using pymobiledevice3 {version} with userspace tunnel support")
PY

(
  cd "$repo_dir/backend"
  "$venv_dir/bin/python" -m unittest discover -s tests -v
  "$venv_dir/bin/python" -m PyInstaller locwarp-backend.spec \
    --noconfirm --distpath ../dist-py --workpath ../build-py
)

(
  cd "$repo_dir/frontend"
  npm ci
  npm test
  npm run build
  case "$macos_arch" in
    arm64) npx electron-builder --mac dir --arm64 -c.mac.type=development -c.mac.identity="$macos_signing_identity" ;;
    x86_64) npx electron-builder --mac dir --x64 -c.mac.type=development -c.mac.identity="$macos_signing_identity" ;;
    universal) npx electron-builder --mac dir --universal -c.mac.type=development -c.mac.identity="$macos_signing_identity" ;;
  esac
)

case "$macos_arch" in
  arm64) release_dir="mac-arm64" ;;
  x86_64) release_dir="mac" ;;
  universal) release_dir="mac" ;;
esac
app_path="$repo_dir/frontend/release/$release_dir/LocWarp.app"
packaged_helper_path="$app_path/Contents/Resources/locwarp-ocr-helper"
codesign --verify --deep --strict "$app_path"

app_team_id=$(codesign -dvv "$app_path" 2>&1 | awk -F= '/^TeamIdentifier=/{ print $2; exit }')
helper_team_id=$(codesign -dvv "$packaged_helper_path" 2>&1 | awk -F= '/^TeamIdentifier=/{ print $2; exit }')
app_requirement=$(codesign -dr - "$app_path" 2>&1 | sed -n 's/^designated => //p')
helper_requirement=$(codesign -dr - "$packaged_helper_path" 2>&1 | sed -n 's/^designated => //p')

if [ -z "$app_team_id" ] || [ "$app_team_id" = "not set" ]; then
  echo "Packaged app does not have a stable TeamIdentifier." >&2
  exit 1
fi
if [ "$helper_team_id" != "$app_team_id" ]; then
  echo "OCR helper TeamIdentifier ($helper_team_id) does not match app ($app_team_id)." >&2
  exit 1
fi
case "$app_requirement" in
  *cdhash*)
    echo "Packaged app still has a CDHash-only designated requirement." >&2
    exit 1
    ;;
esac
case "$helper_requirement" in
  *cdhash*)
    echo "OCR helper still has a CDHash-only designated requirement." >&2
    exit 1
    ;;
esac

echo "Built with stable TeamIdentifier $app_team_id: $app_path"
