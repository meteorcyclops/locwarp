const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const deviceSource = fs.readFileSync(path.join(__dirname, '../src/hooks/useDevice.ts'), 'utf8');
const gpsSource = fs.readFileSync(path.join(__dirname, '../src/components/GpsWatchControl.tsx'), 'utf8');
const statusSource = fs.readFileSync(path.join(__dirname, '../src/components/DeviceStatus.tsx'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, '../src/services/api.ts'), 'utf8');

test('Wi-Fi auto-connect skips only occupied devices and uses backend capacity', () => {
  assert.match(appSource, /api\.listDevices\(\)\.catch/);
  assert.match(appSource, /alreadyTunneledUdids/);
  assert.match(appSource, /status\s+as any\)\?\.max_devices/);
  assert.match(appSource, /const limited = uniq\.slice\(0, availableSlots\)/);
  assert.match(appSource, /Promise\.allSettled\(\s*limited\.map/);
  assert.doesNotMatch(appSource, /if \(device\.connectedDevices\.length > 0\) return/);
});

test('pinned Wi-Fi reconnect falls back from stale saved IP to UDID-verified discovery', () => {
  assert.match(appSource, /const uniquePinnedUdids = Array\.from\(new Set\(pinnedUdids\)\)/);
  assert.match(appSource, /const savedByUdid = new Map/);
  assert.match(appSource, /for \(const endpoint of endpoints\)/);
  assert.match(appSource, /startWifiTunnel\(endpoint\.ip, endpoint\.port, udid, endpoint\.ports\)/);
  assert.match(appSource, /candidate\.udid && candidate\.udid !== udid/);
  assert.match(appSource, /Saved IP may be stale; continue with the next/);
  assert.match(deviceSource, /wifiTunnelDiscover/);
  assert.match(deviceSource, /pinReconnectInFlightRef/);
  assert.match(deviceSource, /startWifiTunnelRef\.current\(endpoint\.ip, endpoint\.port, udid, endpoint\.ports\)/);
  assert.match(deviceSource, /UDID-hinted handshake below verifies the peer/);
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
