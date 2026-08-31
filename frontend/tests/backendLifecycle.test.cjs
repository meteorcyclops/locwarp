const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');

test('Electron snapshots and validates Wi-Fi worker children before backend shutdown', () => {
  assert.match(mainSource, /backendWorkerChildren\(child\.pid\)/);
  assert.match(mainSource, /command\.includes\('--wifi-worker'\)/);
  assert.match(mainSource, /await stopBackendWorkers\(workerPids\)/);
  assert.match(mainSource, /signalBackendWorkers\(workerPids, 'SIGKILL'\)/);
});

test('stale packaged backend replacement also cleans its validated workers', () => {
  assert.match(mainSource, /stopStaleMacBackend[\s\S]*backendWorkerChildren\(pid\)/);
  assert.match(mainSource, /stopStaleMacBackend[\s\S]*stopBackendWorkers\(workerPids\)/);
});

test('macOS native application menu preserves Command+Q cleanup', () => {
  assert.match(mainSource, /process\.platform === 'darwin'[\s\S]{0,220}\{ role: 'appMenu' \}/);
  assert.match(mainSource, /app\.on\('before-quit',[\s\S]{0,520}await stopBackend|app\.on\('before-quit',[\s\S]{0,520}stopBackend\(\)/);
});
