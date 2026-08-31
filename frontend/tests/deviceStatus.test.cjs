const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/deviceStatus.ts')));

const health = (overrides = {}) => ({
  udid: 'device',
  state: 'connected',
  usb_disconnects_5m: 0,
  ...overrides,
});

test('GPS health wins when Network has no independent tunnel row', async () => {
  const { getDeviceStage } = await moduleUnderTest;
  assert.equal(getDeviceStage({
    isConnected: false,
    connectionType: 'Network',
    hasTunnel: false,
    health: health({ location_channel_state: 'healthy' }),
  }), 'gps');
});

test('device state progression distinguishes pending, recovery, and offline', async () => {
  const { getDeviceStage } = await moduleUnderTest;
  assert.equal(getDeviceStage({ isConnected: false, connectionType: 'USB' }), 'paired');
  assert.equal(getDeviceStage({ isConnected: false, connectionType: 'Network' }), 'exploring');
  assert.equal(getDeviceStage({ isConnected: true, connectionType: 'Network', hasTunnel: true }), 'tunnel');
  assert.equal(getDeviceStage({ isConnected: true, connectionType: 'USB' }), 'gps_waiting');
  assert.equal(getDeviceStage({
    isConnected: true,
    connectionType: 'USB',
    health: health({ location_channel_state: 'recovering' }),
  }), 'recovering');
  assert.equal(getDeviceStage({
    isConnected: false,
    connectionType: 'USB',
    health: health({ state: 'usb_absent', is_connected: false }),
  }), 'offline');
});

test('group count only treats proven GPS stages as ready', async () => {
  const { countGpsReady } = await moduleUnderTest;
  const stages = ['gps', 'tunnel', 'recovering', 'gps'];
  assert.equal(countGpsReady(stages, (stage) => stage), 2);
});

test('discovery hides link-local endpoints by default', async () => {
  const { collapseLinkLocalDiscovery, isLinkLocalIpv4 } = await moduleUnderTest;
  const items = [
    { ip: '169.254.205.55', port: 49152, host: 'saburina.local' },
    { ip: '192.168.1.118', port: 49152, host: 'saburina.local' },
    { ip: '192.168.1.116', port: 50268, host: 'nokia-3310.local' },
  ];
  const result = collapseLinkLocalDiscovery(items);
  assert.deepEqual(result.map((item) => `${item.ip}:${item.port}`), [
    '192.168.1.118:49152',
    '192.168.1.116:50268',
  ]);
  assert.equal(isLinkLocalIpv4('169.254.205.55'), true);
  assert.equal(isLinkLocalIpv4('169.253.205.55'), false);
});

test('discovery resolves saved identity when mDNS omits UDID and reports a service UUID', async () => {
  const { resolveDiscoveryIdentity } = await moduleUnderTest;
  const result = resolveDiscoveryIdentity(
    {
      ip: '192.168.1.118',
      // The phone may advertise a newly assigned RemotePairing port; the
      // saved endpoint should still identify it by IP as a fallback.
      port: 50268,
      name: 'A1B2C3D4-E5F6-47A8-9012-3456789ABCDE',
    },
    [{
      ip: '192.168.1.118',
      port: 49152,
      udid: '00008110-001C12345678001E',
      name: 'Sabrina',
      model: 'iPhone 15 Pro',
    }],
  );
  assert.deepEqual(result, {
    name: 'Sabrina',
    model: 'iPhone 15 Pro',
    suffix: '5678001E',
  });
});
