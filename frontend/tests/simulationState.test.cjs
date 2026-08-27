const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/simulationState.ts')));

test('teleporting state is not treated as an active route', async () => {
  const { isRouteRunningStatus } = await moduleUnderTest;
  assert.equal(isRouteRunningStatus({ running: true, state: 'teleporting' }), false);
});

test('route states remain protected while running', async () => {
  const { isRouteRunningStatus } = await moduleUnderTest;
  for (const state of ['navigating', 'looping', 'multistop', 'random_walk', 'joystick', 'paused']) {
    assert.equal(isRouteRunningStatus({ running: true, state }), true, state);
  }
});

test('idle and disconnected stale flags do not block passive actions', async () => {
  const { isRouteRunningStatus } = await moduleUnderTest;
  assert.equal(isRouteRunningStatus({ running: true, state: 'idle' }), false);
  assert.equal(isRouteRunningStatus({ running: true, state: 'disconnected' }), false);
  assert.equal(isRouteRunningStatus({ running: false, state: 'looping' }), false);
  assert.equal(isRouteRunningStatus(null), false);
});

