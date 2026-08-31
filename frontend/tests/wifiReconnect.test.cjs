const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUnderTest = import(pathToFileURL(path.join(__dirname, '../src/utils/wifiReconnect.ts')));

const context = {
  signature: 'en0|192.168.1.125|192.168.1.0/24',
  interfaceName: 'en0',
  ipv4: '192.168.1.125',
  cidr: 24,
  subnet: '192.168.1.0/24',
  changedAt: 100,
};

test('endpoint validation rejects link-local, stale-subnet, and unreachable candidates', async () => {
  const { isUsableWifiEndpoint } = await moduleUnderTest;
  assert.equal(isUsableWifiEndpoint({ ip: '169.254.56.235', port: 49152 }, context), false);
  assert.equal(isUsableWifiEndpoint({ ip: '192.168.72.143', port: 49152 }, context), false);
  assert.equal(isUsableWifiEndpoint({ ip: '192.168.1.118', port: 49152, reachable: false }, context), false);
  assert.equal(isUsableWifiEndpoint({ ip: '192.168.1.118', port: 49152 }, context), true);
});

test('saved endpoint comes first and discovery is filtered by identity, network, and duplicate address', async () => {
  const { buildWifiReconnectEndpoints } = await moduleUnderTest;
  const udid = '00008110-000E45C22122801E';
  const endpoints = buildWifiReconnectEndpoints(
    udid,
    { ip: '192.168.1.118', port: 49152, udid },
    [
      { ip: '192.168.1.118', port: 49152, udid, name: 'Sabrina' },
      { ip: '192.168.1.119', port: 49153, udid: 'other-device', name: 'Other' },
      { ip: '169.254.10.20', port: 49154, name: 'Stale Bonjour' },
      { ip: '192.168.72.50', port: 49155, name: 'Old subnet' },
      { ip: '192.168.1.120', port: 49156, name: 'IP-only candidate' },
    ],
    context,
  );
  assert.deepEqual(endpoints.map(({ ip, port }) => ip + ':' + port), [
    '192.168.1.118:49152',
    '192.168.1.120:49156',
  ]);
  assert.equal(endpoints[0].udid, udid);
});

test('endpoint persistence requires a returned matching UDID and current-network address', async () => {
  const { shouldPersistWifiEndpoint } = await moduleUnderTest;
  const udid = '00008110-000E45C22122801E';
  const endpoint = { ip: '192.168.1.118', port: 49152 };
  assert.equal(shouldPersistWifiEndpoint(udid, udid, endpoint, context), true);
  assert.equal(shouldPersistWifiEndpoint(udid, 'different', endpoint, context), false);
  assert.equal(shouldPersistWifiEndpoint(udid, udid, { ip: '169.254.1.2', port: 49152 }, context), false);
  assert.equal(shouldPersistWifiEndpoint(udid, undefined, endpoint, context), false);
});

test('network context changes use signature and deterministic field fallback', async () => {
  const { networkContextChanged } = await moduleUnderTest;
  assert.equal(networkContextChanged(context, { ...context, changedAt: 200 }), false);
  assert.equal(networkContextChanged(context, { ...context, signature: 'en0|10.0.0.5|10.0.0.0/24', ipv4: '10.0.0.5', subnet: '10.0.0.0/24' }), true);
  assert.equal(networkContextChanged(
    { signature: '', interfaceName: 'en0', ipv4: '192.168.1.125', cidr: 24, subnet: '192.168.1.0/24' },
    { signature: '', interfaceName: 'en0', ipv4: '192.168.1.126', cidr: 24, subnet: '192.168.1.0/24' },
  ), true);
});

test('pairing repair is reserved for explicit pairing failures', async () => {
  const { isPairingInvalidError } = await moduleUnderTest;
  assert.equal(isPairingInvalidError({ code: 'remote_pair_failed' }), true);
  assert.equal(isPairingInvalidError(new Error('nothing is answering RemotePairing there')), false);
  assert.equal(isPairingInvalidError(new Error('connection timeout')), false);
});
