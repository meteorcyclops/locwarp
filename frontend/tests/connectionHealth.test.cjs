const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/utils/connectionHealth.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', compiled)(moduleUnderTest, moduleUnderTest.exports);
const { reconcileConnectionHealth } = moduleUnderTest.exports;

test('connected device metadata replaces a stale stability sample', () => {
  const result = reconcileConnectionHealth({
    udid: 'phone', state: 'stabilizing', usb_disconnects_5m: 1,
    stable_samples: 2, required_samples: 3,
  }, 'phone');
  assert.equal(result.state, 'connected');
  assert.equal(result.usb_disconnects_5m, 1);
});

test('disconnected views keep the backend health state', () => {
  const health = { udid: 'phone', state: 'usb_absent', usb_disconnects_5m: 2 };
  assert.equal(reconcileConnectionHealth(health, null), health);
});

