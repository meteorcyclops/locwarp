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
    arm64) npx electron-builder --mac dir --arm64 -c.mac.identity=null ;;
    x86_64) npx electron-builder --mac dir --x64 -c.mac.identity=null ;;
    universal) npx electron-builder --mac dir --universal -c.mac.identity=null ;;
  esac
)

case "$macos_arch" in
  arm64) release_dir="mac-arm64" ;;
  x86_64) release_dir="mac" ;;
  universal) release_dir="mac" ;;
esac
app_path="$repo_dir/frontend/release/$release_dir/LocWarp.app"
# identity=null keeps local builds independent of a Developer ID certificate,
# but Electron's nested framework signatures still need a final consistent
# ad-hoc seal after extraResources (including the OCR helper) are copied in.
codesign --force --deep --sign - "$app_path"
codesign --verify --deep --strict "$app_path"
echo "Built and ad-hoc signed: $app_path"
