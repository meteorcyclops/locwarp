#!/usr/bin/env bash
set -euo pipefail

CHROME_APP="/Applications/Google Chrome.app"
if [[ ! -d "$CHROME_APP" ]]; then
  echo "Google Chrome.app not found at $CHROME_APP" >&2
  exit 1
fi

PROFILE_DIR="$HOME/Library/Application Support/Chrome-GPS-Share"
mkdir -p "$PROFILE_DIR"

args=(
  "--user-data-dir=$PROFILE_DIR"
  "--profile-directory=Default"
  "--disable-extensions"
  "--no-first-run"
  "--no-default-browser-check"
)

if [[ $# -eq 0 ]]; then
  args+=("about:blank")
else
  args+=("$@")
fi

open -na "$CHROME_APP" --args "${args[@]}"
