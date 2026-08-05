const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/bookmarkCollapse.ts')));

test('recognizes both stored default category names', async () => {
  const { isDefaultBookmarkCategory } = await moduleUnderTest;
  assert.equal(isDefaultBookmarkCategory('預設'), true);
  assert.equal(isDefaultBookmarkCategory('Default'), true);
  assert.equal(isDefaultBookmarkCategory('Work'), false);
});

test('always expands default while preserving saved state for other categories', async () => {
  const { initialBookmarkCollapseState } = await moduleUnderTest;
  assert.deepEqual(
    initialBookmarkCollapseState(['預設', 'Work', 'Trips'], ['Trips'], true),
    { 預設: false, Work: true, Trips: false },
  );
});

test('large unsaved libraries collapse only non-default categories', async () => {
  const { initialBookmarkCollapseState } = await moduleUnderTest;
  assert.deepEqual(
    initialBookmarkCollapseState(['Default', 'Work'], null, true),
    { Default: false, Work: true },
  );
});
