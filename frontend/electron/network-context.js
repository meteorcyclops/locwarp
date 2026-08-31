const ipv4ToInt = (address) => {
  const parts = String(address || '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0)
}

const prefixFromNetmask = (netmask) => {
  const value = ipv4ToInt(netmask)
  if (value === null) return null
  let prefix = 0
  let zeroSeen = false
  for (let bit = 31; bit >= 0; bit -= 1) {
    const one = (value & (1 << bit)) !== 0
    if (one && zeroSeen) return null
    if (one) prefix += 1
    else zeroSeen = true
  }
  return prefix
}

const networkAddress = (address, netmask) => {
  const addressValue = ipv4ToInt(address)
  const maskValue = ipv4ToInt(netmask)
  if (addressValue === null || maskValue === null) return null
  const value = (addressValue & maskValue) >>> 0
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.')
}

function buildNetworkContext(interfaces, preferredName, previous = null, now = Date.now()) {
  const candidates = []
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue
      candidates.push({ name, entry })
    }
  }
  const selected = candidates.find(({ name }) => name === preferredName) || candidates[0] || null
  const interfaceName = selected?.name || preferredName || null
  const ipv4 = selected?.entry?.address || null
  const cidr = selected ? prefixFromNetmask(selected.entry.netmask) : null
  const subnetBase = selected ? networkAddress(selected.entry.address, selected.entry.netmask) : null
  const subnet = subnetBase && cidr !== null ? `${subnetBase}/${cidr}` : null
  const signature = `${interfaceName || 'none'}|${ipv4 || 'none'}|${subnet || 'none'}`
  return {
    signature,
    interfaceName,
    ipv4,
    cidr,
    subnet,
    changedAt: previous?.signature === signature ? previous.changedAt : now,
  }
}

module.exports = { buildNetworkContext, ipv4ToInt, prefixFromNetmask, networkAddress }
