const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const controlSource = fs.readFileSync(path.join(__dirname, '../src/components/GpsWatchControl.tsx'), 'utf8');
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
