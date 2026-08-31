const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')

test('settings diagnostics uses the authenticated backend contract and real runtime versions', () => {
  const api = read('src/services/api.ts')
  const panel = read('src/components/SystemDiagnosticsPanel.tsx')
  const preload = read('electron/preload.js')

  assert.match(api, /request<SystemDiagnostics>\('GET', '\/api\/diagnostics\/system', undefined, \{ maxAttempts: 1 \}\)/)
  assert.match(preload, /runtimeVersions:[\s\S]*process\.versions\.electron[\s\S]*process\.versions\.chrome[\s\S]*process\.versions\.node/)
  assert.match(panel, /getSystemDiagnostics\(\)/)
  assert.match(panel, /window\.electronAPI\?\.gpsWatch\?\.status\(\)/)
})

test('diagnostics keeps unknown evidence visible and reports missing strict-group members', () => {
  const panel = read('src/components/SystemDiagnosticsPanel.tsx')
  const settings = read('src/components/SettingsPage.tsx')
  const strings = read('src/i18n/strings.ts')

  assert.match(panel, /valueOrUnknown/)
  assert.match(panel, /missing_udids/)
  assert.match(panel, /diagnostics\.not_verified/)
  assert.match(settings, /<SystemDiagnosticsPanel \/>/)
  assert.match(strings, /'diagnostics\.group_title'/)
  assert.match(strings, /'diagnostics\.last_checked'/)
})
