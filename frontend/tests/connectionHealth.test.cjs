const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/connectionHealth.ts')));

test('connected device metadata replaces a stale stability sample', async () => {
  const { reconcileConnectionHealth } = await moduleUnderTest;
  const result = reconcileConnectionHealth({
    udid: 'phone', state: 'stabilizing', usb_disconnects_5m: 1,
    stable_samples: 2, required_samples: 3,
  }, 'phone');
  assert.equal(result.state, 'connected');
  assert.equal(result.usb_disconnects_5m, 1);
});

test('disconnected views keep the backend health state', async () => {
  const { reconcileConnectionHealth } = await moduleUnderTest;
  const health = { udid: 'phone', state: 'usb_absent', usb_disconnects_5m: 2 };
  assert.equal(reconcileConnectionHealth(health, null), health);
});

test('connected reconciliation preserves recent instability evidence', async () => {
  const { reconcileConnectionHealth } = await moduleUnderTest;
  const result = reconcileConnectionHealth({
    udid: 'phone', state: 'usb_flapping', usb_disconnects_5m: 4,
    likely_hardware: true, last_disconnect_unix: 1_700_000_000,
  }, 'phone');
  assert.equal(result.state, 'connected');
  assert.equal(result.is_connected, true);
  assert.equal(result.usb_disconnects_5m, 4);
  assert.equal(result.likely_hardware, true);
  assert.equal(result.last_disconnect_unix, 1_700_000_000);
});
