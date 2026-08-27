#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_output_dir="${TMPDIR:-/tmp}/locwarp-ocr-helper-test"
mkdir -p "$test_output_dir"
test_binary="$test_output_dir/locwarp-ocr-helper"

xcrun swiftc "$repo_dir/macos/locwarp-ocr-helper/main.swift" -O \
  -target arm64-apple-macosx12.3 \
  -framework AppKit \
  -framework CoreGraphics \
  -framework CoreMedia \
  -framework ImageIO \
  -framework ScreenCaptureKit \
  -framework Vision \
  -o "$test_binary"

"$test_binary" --self-test

if [ "$#" -gt 0 ]; then
  "$test_binary" --fixture "$1" --fast
fi
