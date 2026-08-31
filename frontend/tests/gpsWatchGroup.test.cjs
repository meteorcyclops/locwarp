const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const deviceSource = fs.readFileSync(path.join(__dirname, '../src/hooks/useDevice.ts'), 'utf8');
const gpsSource = fs.readFileSync(path.join(__dirname, '../src/components/GpsWatchControl.tsx'), 'utf8');
const statusSource = fs.readFileSync(path.join(__dirname, '../src/components/DeviceStatus.tsx'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, '../src/services/api.ts'), 'utf8');

test('Wi-Fi auto-connect reuses the hook pipeline with capacity and epoch guards', () => {
  assert.match(appSource, /device\.autoConnectWifi\(\)/);
  assert.match(appSource, /if \(!ws\.connected\) \{[\s\S]*wifiAutoConnectAttemptedRef\.current = false/);
  assert.doesNotMatch(appSource, /api\.wifiTunnelDiscover\(\)/);
  assert.match(deviceSource, /Promise\.allSettled\(\[\s*wifiTunnelStatus/);
  assert.match(deviceSource, /const availableSlots = Math\.max\(0, maxDevices - occupiedUdids\.size\)/);
  assert.match(deviceSource, /buildWifiReconnectEndpoints\(/);
  assert.match(deviceSource, /Promise\.allSettled\(selectedGroups\.map/);
  assert.doesNotMatch(appSource, /if \(device\.connectedDevices\.length > 0\) return/);
});

test('pinned Wi-Fi reconnect falls back from stale saved IP to UDID-verified discovery', () => {
  assert.match(deviceSource, /const SAVED_ENDPOINT_TIMEOUT_MS = 30_000/);
  assert.match(deviceSource, /const DISCOVERY_TIMEOUT_MS = 22_000/);
  assert.match(deviceSource, /const TUNNEL_HANDSHAKE_TIMEOUT_MS = 30_000/);
  assert.match(deviceSource, /const saved = readSavedEntryFor\(udid\)/);
  assert.match(deviceSource, /tryEndpoint\(saved, 'last_ip', SAVED_ENDPOINT_TIMEOUT_MS\)/);
  assert.match(deviceSource, /updateWifiReconnect\(key, 'network_changed_discovery'/);
  assert.match(deviceSource, /for \(const endpoint of endpoints\)/);
  assert.match(deviceSource, /request\.controller\.signal/);
  assert.match(deviceSource, /const epochCurrent = \(\) =>/);
  assert.match(deviceSource, /if \(!epochCurrent\(\) \|\| request\.controller\.signal\.aborted\) return 'stale'/);
  assert.match(deviceSource, /wifiTunnelDiscover/);
  assert.match(deviceSource, /tryEndpoint\(endpoint, 'tunnel', TUNNEL_HANDSHAKE_TIMEOUT_MS\)/);
  assert.match(deviceSource, /stage !== 'tunnel'/);
  assert.match(apiSource, /rescan = true/);
  assert.match(deviceSource, /pinReconnectInFlightRef/);
  assert.match(deviceSource, /startWifiTunnelRef\.current\(/);
  assert.match(deviceSource, /isPairingInvalidError\(error\)/);
  assert.match(deviceSource, /shouldPersistWifiEndpoint/);
  assert.match(deviceSource, /Backend startup can restore a device before the renderer subscribes/);
});

test('GPS Watch exposes strict all-device target mode and group fan-out', () => {
  assert.match(gpsSource, /GpsWatchTargetMode = 'primary' \| 'all'/);
  assert.match(gpsSource, /connectedUdids\?: string\[\]/);
  assert.match(gpsSource, /onTeleportAll\?:/);
  assert.match(gpsSource, /sessionTargetsRef/);
  assert.match(gpsSource, /全部 \{connectedUdids\.length\} 台/);
  assert.match(gpsSource, /同步群組裝置清單已變更/);
  assert.match(appSource, /onTeleportAll=\{handleGpsWatchTeleportAll\}/);
  assert.match(appSource, /api\.teleportBatch\(coordinate\.lat, coordinate\.lng, targetUdids, true\)/);
  assert.match(apiSource, /\/api\/location\/teleport\/batch/);
  assert.match(gpsSource, /同步瞬移部分失敗/);
  assert.match(gpsSource, /modeForSession === 'all' && failed > 0/);
  assert.match(gpsSource, /同步停止 · \$\{succeeded\}\/\$\{sessionTargets\.length\} 台已送出/);
  assert.match(gpsSource, /stop\(false, true\)/);
  assert.match(gpsSource, /chooseAmbiguous[\s\S]*dispatchAll\(coordinate, sessionTargets\)/);
});

test('tunnel UI accepts backend capacity while retaining the legacy macOS fallback', () => {
  assert.match(apiSource, /max_devices\?: number/);
  assert.match(deviceSource, /PRODUCT_MAX_TUNNEL_DEVICES = 3/);
  assert.match(deviceSource, /DEFAULT_MAX_TUNNEL_DEVICES = typeof window/);
  assert.match(statusSource, /maxTunnelDevices\?: number/);
  assert.match(statusSource, /PRODUCT_MAX_TUNNEL_DEVICES/);
  assert.doesNotMatch(statusSource, /window\.electronAPI\?\.platform === 'darwin' \? 1 : 3;[\s\S]{0,300}Math\.min\(DEFAULT_MAX_TUNNEL_DEVICES/);
});

test('connection page de-duplicates tunnel and pin identity case-insensitively', () => {
  assert.match(statusSource, /canonicalUdid\(tn\.udid\) !== canonicalUdid\(device\?\.id\)/);
  assert.match(statusSource, /const isPinnedUdid =/);
  assert.doesNotMatch(statusSource, /pinnedUdids\.includes\(/);
  assert.doesNotMatch(statusSource, /tn\.udid !== device\?\.id/);
});
