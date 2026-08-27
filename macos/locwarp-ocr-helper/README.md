# LocWarp macOS OCR helper

`locwarp-ocr-helper` is a local-only child process used by the macOS app's
frame-selection workflow. ScreenCaptureKit sends an in-memory pixel buffer to
Vision; the helper emits recognized text and decimal `latitude,longitude`
candidates as newline-delimited JSON. It does not save screenshots, use the
clipboard, or upload captured content.

## Build

The normal macOS release script compiles and embeds the helper's usage
description before electron-builder packages it as an extra resource:

```sh
./scripts/build-macos.sh
```

For a quick local compile and parser test:

```sh
mkdir -p /tmp/locwarp-ocr-helper
xcrun swiftc macos/locwarp-ocr-helper/main.swift -O \
  -target arm64-apple-macosx12.3 \
  -framework AppKit -framework CoreGraphics -framework CoreMedia \
  -framework ImageIO -framework ScreenCaptureKit -framework Vision \
  -o /tmp/locwarp-ocr-helper/locwarp-ocr-helper
/tmp/locwarp-ocr-helper/locwarp-ocr-helper --self-test
```

The fixture entry point runs Vision once without ScreenCaptureKit. It is useful
for testing OCR against a screenshot supplied by the user:

```sh
/tmp/locwarp-ocr-helper/locwarp-ocr-helper --fixture /path/to/fixture.png --fast
```

## Protocol

The process prints one JSON object per line. The first line for a capture
session is:

```json
{"event":"ready","protocol":"ndjson-v1", "state":"idle"}
```

Send commands on stdin:

```json
{"command":"start","displayID":123,"x":0,"y":0,"width":700,"height":320,"fps":6}
{"command":"stop"}
{"command":"status"}
{"command":"shutdown"}
```

`start` also accepts an ROI object:

```json
{"command":"start","displayID":123,"roi":{"x":0,"y":0,"width":700,"height":320,"units":"points"}}
```

ROI coordinates are local to the selected display. `units: "points"` is the
default and is converted to pixels using the display's inferred Retina scale;
`units: "pixels"` is also accepted. The capture cadence is clamped to 5–8
fps (default 6 fps). The helper excludes windows belonging to
`com.locwarp.app` when that application is present in ScreenCaptureKit's
shareable content.

Events include:

- `permission`: `requesting`, `granted`, or `denied`.
- `started`: resolved display, ROI, scale, fps, and recognition level.
- `frame`: `texts` contains `{text, confidence, boundingBox}` entries with
  normalized Vision bounding boxes; `candidates` contains validated decimal
  latitude/longitude pairs.
- `stopped`: capture has been stopped and its stream released.
- `error`: machine-readable `code`, operation, and message.

The parent process should require two matching `candidates` frames before a
teleport and should send `stop`/`shutdown` on cancellation or exit.
