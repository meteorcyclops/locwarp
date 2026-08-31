const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

const { buildNetworkContext } = require(path.join(__dirname, '../electron/network-context.js'))

const interfaces = {
  en0: [
    { family: 'IPv4', internal: false, address: '192.168.50.12', netmask: '255.255.255.0' },
    { family: 'IPv4', internal: false, address: '169.254.2.9', netmask: '255.255.0.0' },
  ],
  en7: [
    { family: 'IPv4', internal: false, address: '10.0.0.8', netmask: '255.255.255.0' },
  ],
}

test('network context follows the default interface and excludes link-local IPv4', () => {
  const result = buildNetworkContext(interfaces, 'en0', null, 100)
  assert.deepEqual(result, {
    signature: 'en0|192.168.50.12|192.168.50.0/24',
    interfaceName: 'en0',
    ipv4: '192.168.50.12',
    cidr: 24,
    subnet: '192.168.50.0/24',
    changedAt: 100,
  })
})

test('network context keeps timestamp for same signature and advances on subnet change', () => {
  const first = buildNetworkContext(interfaces, 'en0', null, 100)
  const same = buildNetworkContext(interfaces, 'en0', first, 200)
  const changed = buildNetworkContext(interfaces, 'en7', same, 300)
  assert.equal(same.changedAt, 100)
  assert.equal(changed.changedAt, 300)
  assert.notEqual(changed.signature, first.signature)
})
