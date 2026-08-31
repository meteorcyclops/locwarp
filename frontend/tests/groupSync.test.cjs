const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const simulationSource = fs.readFileSync(path.join(__dirname, '../src/hooks/useSimulation.ts'), 'utf8')
const statusSource = fs.readFileSync(path.join(__dirname, '../src/components/DeviceStatus.tsx'), 'utf8')
const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')

test('group recovery events and ACK skew are preserved for the UI', () => {
  assert.match(simulationSource, /wsMessage\.type === 'group_sync'/)
  assert.match(simulationSource, /group_max_ack_delta_ms/)
  assert.match(simulationSource, /groupSyncStatus,/)
  assert.match(simulationSource, /groupMaxAckDeltaMs,/)
})

test('connection page shows strict recovery progress and maximum sync delta', () => {
  assert.match(statusSource, /group\.reconnecting/)
  assert.match(statusSource, /group\.max_sync_delta/)
  assert.match(appSource, /groupSyncStatus=\{sim\.groupSyncStatus\}/)
  assert.match(appSource, /groupMaxAckDeltaMs=\{sim\.groupMaxAckDeltaMs\}/)
})

test('connection page exposes the per-device Wi-Fi reconnect phase', () => {
  assert.match(statusSource, /wifi\.reconnect_last_ip/)
  assert.match(statusSource, /wifi\.reconnect_network_changed/)
  assert.match(statusSource, /wifi\.reconnect_needs_usb/)
  assert.match(appSource, /wifiReconnects=\{device\.wifiReconnects\}/)
  assert.match(statusSource, /connection\.location_pending_detail/)
})
