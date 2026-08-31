const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/deviceStatus.ts')))
const statusSource = fs.readFileSync(path.join(__dirname, '../src/components/DeviceStatus.tsx'), 'utf8')
const simulationSource = fs.readFileSync(path.join(__dirname, '../src/hooks/useSimulation.ts'), 'utf8')

test('status center keeps unknown transport unverified and recognizes real tunnel evidence', async () => {
  const { getDeviceTransport } = await moduleUnderTest
  assert.equal(getDeviceTransport(undefined, false), 'unknown')
  assert.equal(getDeviceTransport('USB', false), 'usb')
  assert.equal(getDeviceTransport('Network', false), 'wifi')
  assert.equal(getDeviceTransport(undefined, true), 'wifi')
})

test('device progress never treats transport or GPS as ready without evidence', async () => {
  const { getDeviceProgress } = await moduleUnderTest
  assert.equal(getDeviceProgress('paired', 'unknown').exploring, 'complete')
  assert.equal(getDeviceProgress('paired', 'unknown').gps, 'unverified')
  assert.equal(getDeviceProgress('tunnel', 'wifi').tunnel, 'active')
  assert.equal(getDeviceProgress('gps_waiting', 'wifi').gps, 'active')
  assert.equal(getDeviceProgress('gps', 'wifi').gps, 'complete')
  assert.equal(getDeviceProgress('recovering', 'usb').gps, 'blocked')
  assert.equal(getDeviceProgress('recovering', 'usb').recovery, 'active')
  assert.equal(getDeviceProgress('offline', 'wifi').gps, 'unverified')
})

test('DeviceStatus renders the per-device trail and real connection metadata', () => {
  assert.match(statusSource, /device-progress-strip/)
  assert.match(statusSource, /group\.device_exploring/)
  assert.match(statusSource, /group\.device_tunnel/)
  assert.match(statusSource, /group\.device_gps_waiting/)
  assert.match(statusSource, /group\.device_recovering/)
  assert.match(statusSource, /device-connection-meta/)
  assert.match(statusSource, /diagnostics\.not_verified/)
  assert.match(statusSource, /LocationHealthMeta health={health} now={now} showEmpty/)
})

test('group status consumes backend member/missing and sync telemetry fields', () => {
  assert.match(simulationSource, /members\?: GroupSyncMember\[\]/)
  assert.match(simulationSource, /missing_udids\?: string\[\]/)
  assert.match(simulationSource, /max_ack_delta_ms\?: number/)
  assert.match(statusSource, /group-sync-missing/)
  assert.match(statusSource, /groupSyncStatus\?\.missing_udids/)
  assert.match(statusSource, /groupSyncStatus\?\.max_ack_delta_ms/)
  assert.match(statusSource, /groupSyncStatus\?\.members/)
})
