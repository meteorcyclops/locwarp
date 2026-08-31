/**
 * Small, deterministic helpers shared by the Wi-Fi reconnect path.
 *
 * The Electron main process owns the authoritative network context.  The
 * renderer deliberately keeps the validation here pure so a stale DHCP
 * address can never become the new saved endpoint just because a scan was
 * interrupted or returned a link-local interface.
 */

export interface WifiNetworkContext {
  signature: string
  interfaceName: string | null
  ipv4: string | null
  cidr: number | null
  subnet: string | null
  changedAt: number
}

export interface WifiReconnectEndpoint {
  ip: string
  port: number
  ports?: number[]
  udid?: string
  name?: string
  host?: string
  reachable?: boolean
  unreachable?: boolean
}

export type WifiReconnectStage =
  | 'idle'
  | 'last_ip'
  | 'network_changed_discovery'
  | 'found_name'
  | 'tunnel'
  | 'connected'
  | 'failed'
  | 'needs_usb_repair'

export interface WifiReconnectStatus {
  udid: string
  stage: WifiReconnectStage
  attempt: number
  ip?: string
  name?: string
  error?: string
  requiresUsbRepair?: boolean
  networkSignature?: string
  updatedAt: number
}

const IPV4_PATTERN = /^(\d{1,3})(?:\.(\d{1,3})){3}$/

/** Return a canonical IPv4 string, or null for hostnames/invalid input. */
export function normalizeIpv4(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!IPV4_PATTERN.test(raw)) return null
  const parts = raw.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }
  return parts.join('.')
}

function ipv4Number(value: string): number {
  return normalizeIpv4(value)?.split('.').reduce((n, part) => (n * 256) + Number(part), 0) ?? -1
}

function parseCidr(value: unknown): { address: string; prefix: number } | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const [addressPart, prefixPart] = raw.split('/')
  const address = normalizeIpv4(addressPart)
  if (!address) return null
  const prefix = prefixPart == null || prefixPart === '' ? 24 : Number(prefixPart)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  return { address, prefix }
}

function contextNetwork(context?: Partial<WifiNetworkContext> | null): { network: number; prefix: number } | null {
  if (!context) return null
  const explicit = parseCidr(context.subnet)
  const address = explicit?.address ?? normalizeIpv4(context.ipv4)
  if (!address) return null
  const rawPrefix = explicit?.prefix ?? Number(context.cidr)
  const prefix = Number.isInteger(rawPrefix) && rawPrefix >= 0 && rawPrefix <= 32 ? rawPrefix : 24
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return { network: ipv4Number(address) & mask, prefix }
}

function sameSubnet(ip: string, context?: Partial<WifiNetworkContext> | null): boolean {
  const network = contextNetwork(context)
  if (!network) return true
  const mask = network.prefix === 0 ? 0 : (0xffffffff << (32 - network.prefix)) >>> 0
  return (ipv4Number(ip) & mask) === network.network
}

export function isLinkLocalIpv4(ip: unknown): boolean {
  const normalized = normalizeIpv4(ip)
  if (!normalized) return false
  const parts = normalized.split('.').map(Number)
  return parts[0] === 169 && parts[1] === 254
}

function isNonRoutableIpv4(ip: string): boolean {
  const n = ipv4Number(ip)
  if (n < 0) return true
  const first = Number(ip.split('.')[0])
  const second = Number(ip.split('.')[1])
  // 0/8, loopback, multicast/reserved, and the limited broadcast address.
  if (first === 0 || first === 127 || first >= 224 || n === 0xffffffff) return true
  // Link-local is never a stable LAN endpoint for this feature. It can be
  // advertised by Bonjour on a stale/secondary interface after DHCP changes.
  if (first === 169 && second === 254) return true
  return false
}

export function isUsableWifiEndpoint(
  endpoint: Pick<WifiReconnectEndpoint, 'ip' | 'reachable' | 'unreachable'>,
  context?: Partial<WifiNetworkContext> | null,
): boolean {
  const ip = normalizeIpv4(endpoint.ip)
  if (!ip || isNonRoutableIpv4(ip)) return false
  if (endpoint.reachable === false || endpoint.unreachable === true) return false
  return sameSubnet(ip, context)
}

export function canonicalUdid(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

export function sameUdid(left: unknown, right: unknown): boolean {
  const a = canonicalUdid(left)
  const b = canonicalUdid(right)
  return Boolean(a && b && a === b)
}

function normalizePort(value: unknown): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/**
 * Build one deterministic endpoint sequence for one pinned UDID.
 *
 * The saved address is tried first only when it belongs to the current
 * network. Discovery results are then filtered by the same network and by a
 * known UDID when the backend supplies one. Older backends may return an
 * IP-only Bonjour result; the caller must pass the desired UDID to the
 * backend so the handshake, not the scan, verifies identity.
 */
export function buildWifiReconnectEndpoints(
  udid: string,
  saved: WifiReconnectEndpoint | null | undefined,
  discovered: WifiReconnectEndpoint[] | null | undefined,
  context?: Partial<WifiNetworkContext> | null,
): WifiReconnectEndpoint[] {
  const result: WifiReconnectEndpoint[] = []
  const seen = new Set<string>()
  const add = (candidate: WifiReconnectEndpoint | null | undefined) => {
    if (!candidate || !isUsableWifiEndpoint(candidate, context)) return
    // An empty target is the cold-start, unpinned path.  It may contain a
    // mixture of saved UDIDs and IP-only Bonjour candidates; the actual
    // start-and-connect handshake still verifies an IP-only candidate before
    // it is accepted.
    if (candidate.udid && udid && !sameUdid(candidate.udid, udid)) return
    const ip = normalizeIpv4(candidate.ip)
    const port = normalizePort(candidate.port)
    if (!ip || port == null) return
    const key = `${ip}:${port}`
    if (seen.has(key)) return
    seen.add(key)
    const ports = Array.from(new Set((candidate.ports ?? [])
      .map(normalizePort)
      .filter((value): value is number => value != null)))
    result.push({ ...candidate, ip, port, ...(ports.length ? { ports } : {}) })
  }
  add(saved)
  for (const candidate of discovered ?? []) add(candidate)
  return result
}

export function shouldPersistWifiEndpoint(
  requestedUdid: string | undefined,
  responseUdid: string | undefined,
  endpoint: WifiReconnectEndpoint,
  context?: Partial<WifiNetworkContext> | null,
): boolean {
  if (!responseUdid || !isUsableWifiEndpoint(endpoint, context)) return false
  return !requestedUdid || sameUdid(requestedUdid, responseUdid)
}

export function isPairingInvalidError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null | undefined
  const code = String(value?.code ?? '').toLowerCase()
  if (code === 'remote_pair_failed' || code === 'trust_failed' || code === 'pairing_invalid') return true
  const message = String(value?.message ?? error ?? '').toLowerCase()
  // The word RemotePairing also appears in ordinary port timeouts and
  // discovery errors, so it is not proof that the trust record is invalid.
  // Only explicit trust/pair-record failures may ask the user for USB again.
  return /pairing\s*(failed|invalid|error)|not\s+paired|(?:pairing|pair)\s+record\s*(missing|invalid|expired|corrupt|failed)|trust\s*(failed|required|invalid)/.test(message)
}

export function networkContextChanged(
  previous: Partial<WifiNetworkContext> | null | undefined,
  next: Partial<WifiNetworkContext> | null | undefined,
): boolean {
  if (!previous || !next) return false
  const fingerprint = (value: Partial<WifiNetworkContext>): string => {
    const signature = String(value.signature ?? '').trim()
    if (signature) return signature
    return [
      String(value.interfaceName ?? '').trim(),
      normalizeIpv4(value.ipv4) ?? '',
      String(value.cidr ?? ''),
      String(value.subnet ?? '').trim(),
    ].join('|')
  }
  const previousFingerprint = fingerprint(previous)
  const nextFingerprint = fingerprint(next)
  return Boolean(previousFingerprint && nextFingerprint && previousFingerprint !== nextFingerprint)
}
