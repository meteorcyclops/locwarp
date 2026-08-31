const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const controlSource = fs.readFileSync(path.join(__dirname, '../src/components/GpsWatchControl.tsx'), 'utf8');
const typesSource = fs.readFileSync(path.join(__dirname, '../src/types/electron.d.ts'), 'utf8');
const helperSource = fs.readFileSync(path.join(__dirname, '../../macos/locwarp-ocr-helper/main.swift'), 'utf8');

test('Electron stop emits a terminal event even when the helper was already cleared', () => {
  assert.match(
    mainSource,
    /if \(!child\) \{[\s\S]{0,240}clearGpsWatchProcessState\(\)[\s\S]{0,160}sendGpsWatchEvent\(\{ event: 'stopped', reason \}\)/,
  );
});

test('concurrent stop requests share one bounded operation and release it afterward', () => {
  assert.match(mainSource, /if \(gpsWatchStopPromise\) return gpsWatchStopPromise/);
  assert.match(mainSource, /const trackedOperation = operation\.finally\(\(\) => \{/);
  assert.match(mainSource, /if \(gpsWatchStopPromise === trackedOperation\) gpsWatchStopPromise = null/);
});

test('renderer reconciles an already-idle helper while showing stopping', () => {
  assert.match(controlSource, /if \(phase !== 'stopping'\) return/);
  assert.match(controlSource, /if \(state === 'idle'\) \{/);
  assert.match(controlSource, /stopPendingRef\.current = false/);
  assert.doesNotMatch(controlSource, /ignoreStoppedRef/);
});

test('latency tuning keeps the two-frame safety gate', () => {
  assert.match(controlSource, /GPS_WATCH_MIN_INTERVAL_MS = 300/);
  assert.match(controlSource, /stabilityFrames: 2/);
  assert.match(mainSource, /fps: 8/);
  assert.match(helperSource, /streamConfiguration\.queueDepth = 2/);
});

test('small-text OCR keeps accurate recognition and lowers only the glyph-height filter', () => {
  assert.match(mainSource, /recognitionLevel: 'accurate'/);
  assert.match(helperSource, /request\.minimumTextHeight = 0\.005/);
  assert.match(controlSource, /minConfidence: 0\.9/);
  assert.match(controlSource, /stabilityFrames: 2/);
});

test('GPS Watch exposes real helper telemetry and an explicit OCR success denominator', () => {
  assert.match(typesSource, /capturedFrameCount\?: number/);
  assert.match(typesSource, /processedFrameCount\?: number/);
  assert.match(typesSource, /capture\?: GpsWatchCaptureTelemetry/);
  assert.match(controlSource, /getGpsWatchTelemetryMetrics/);
  assert.match(controlSource, /helper 已進入 OCR 幀（processedFrameCount）/);
  assert.match(controlSource, /最近辨識/);
  assert.match(controlSource, /擷丟/);
  assert.match(controlSource, /失 \{stats\.failed\}/);
  assert.match(controlSource, /送 \{delivery\.ok\}\/\{delivery\.total\}/);
});

test('GPS Watch clears scan-only observability when the session returns idle', () => {
  assert.match(controlSource, /const showObservability = phase !== 'idle'/);
  assert.match(controlSource, /resetScanObservability\(\)\n\s+setPhase\('idle'\)/);
});
