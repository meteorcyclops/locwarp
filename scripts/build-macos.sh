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
  npx electron-builder --mac dir --arm64 -c.mac.identity=null
)

echo "Built: $repo_dir/frontend/release/mac-arm64/LocWarp.app"
