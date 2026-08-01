const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/utils/bookmarkCollapse.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', compiled)(moduleUnderTest, moduleUnderTest.exports);
const { initialBookmarkCollapseState, isDefaultBookmarkCategory } = moduleUnderTest.exports;

test('recognizes both stored default category names', () => {
  assert.equal(isDefaultBookmarkCategory('預設'), true);
  assert.equal(isDefaultBookmarkCategory('Default'), true);
  assert.equal(isDefaultBookmarkCategory('Work'), false);
});

test('always expands default while preserving saved state for other categories', () => {
  assert.deepEqual(
    initialBookmarkCollapseState(['預設', 'Work', 'Trips'], ['Trips'], true),
    { 預設: false, Work: true, Trips: false },
  );
});

test('large unsaved libraries collapse only non-default categories', () => {
  assert.deepEqual(
    initialBookmarkCollapseState(['Default', 'Work'], null, true),
    { Default: false, Work: true },
  );
});

