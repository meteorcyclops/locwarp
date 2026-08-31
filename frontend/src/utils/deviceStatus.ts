import type { ConnectionHealth } from '../services/api';

/**
 * The UI state machine for one device.  Keep this separate from the backend
 * connection state: a TCP tunnel is only an intermediate step, while GPS
 * readiness is proven by the location channel health event.
 */
export type DeviceStage =
  | 'paired'
  | 'exploring'
  | 'tunnel'
  | 'gps_waiting'
  | 'gps'
  | 'recovering'
  | 'offline';

export interface DeviceStageInput {
  isConnected?: boolean;
  connectionType?: string;
  hasTunnel?: boolean;
  health?: ConnectionHealth;
}

const DISCONNECTED_HEALTH_STATES = new Set<ConnectionHealth['state']>([
  'usb_absent',
  'reconnect_backoff',
  'usb_flapping',
]);

function sameDeviceState(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === expected;
}

/**
 * Resolve the display stage in progression order:
 * paired → exploring → tunnel → GPS pending → GPS ready → recovering → offline.
 *
 * `location_channel_state=healthy` intentionally wins over the absence of a
 * frontend tunnel row.  Network/CoreDevice can own a connection without the
 * UI having a separately published worker, and the accepted GPS write is the
 * stronger readiness signal.
 */
export function getDeviceStage(input: DeviceStageInput): DeviceStage {
  const health = input.health;
  const isNetwork = sameDeviceState(input.connectionType, 'network');
  const locationLive = health?.location_channel_state === 'healthy'
    || health?.location_channel_state === 'recovering';
  const hasTransport = input.isConnected === true
    || input.hasTunnel === true
    || health?.is_connected === true
    || locationLive;

  const explicitlyOffline = DISCONNECTED_HEALTH_STATES.has(health?.state as ConnectionHealth['state'])
    || (health?.is_connected === false && health.last_disconnect_unix != null);
  if (explicitlyOffline) return 'offline';

  // Recovery is a live-but-not-yet-safe location channel.  It must be shown
  // after GPS-ready in the state ordering, but before falling back to tunnel.
  if (hasTransport && health?.location_channel_state === 'recovering') return 'recovering';

  // Never infer GPS readiness from a tunnel alone, but do trust the backend's
  // location health even when a Network device has no independent worker row.
  if (hasTransport && health?.location_channel_state === 'healthy') return 'gps';

  if (!hasTransport) {
    return isNetwork || health?.state === 'connecting' ? 'exploring' : 'paired';
  }

  if (isNetwork && input.hasTunnel === true) return 'tunnel';
  if (isNetwork) return 'exploring';
  return 'gps_waiting';
}

export function isGpsReady(stage: DeviceStage): boolean {
  return stage === 'gps';
}

export function countGpsReady<T>(items: T[], stageOf: (item: T) => DeviceStage): number {
  return items.reduce((count, item) => count + (isGpsReady(stageOf(item)) ? 1 : 0), 0);
}

export function formatUdidSuffix(udid: string | undefined | null, length = 8): string {
  const value = String(udid || '').trim();
  return value ? value.slice(-Math.max(1, length)).toUpperCase() : '';
}

export function isLinkLocalIpv4(ip: string | undefined | null): boolean {
  const value = String(ip || '').trim();
  const match = /^169\.254\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return Boolean(match && Number(match[1]) <= 255 && Number(match[2]) <= 255);
}

export interface DiscoveryEndpoint {
  ip: string;
  port: number;
  ports?: number[];
  host?: string;
  name?: string;
  model?: string;
  ios_version?: string;
  iosVersion?: string;
  udid?: string;
}

export interface DiscoveryIdentityDevice {
  id: string;
  name?: string;
  model?: string;
  iosVersion?: string;
}

export interface SavedDiscoveryEndpoint {
  ip: string;
  port: number;
  udid?: string;
  name?: string;
  model?: string;
}

export interface DiscoveryIdentity {
  name: string;
  model: string;
  suffix: string;
}

const SERVICE_UUID_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Resolve a human-readable discovery row without trusting mDNS's `name` as a
 * device name.  RemotePairing commonly exposes its service UUID there and
 * omits the UDID; a previously successful IP/port is the strongest local
 * identity hint in that case.
 */
export function resolveDiscoveryIdentity(
  endpoint: DiscoveryEndpoint,
  savedEndpoints: SavedDiscoveryEndpoint[] = [],
  devices: DiscoveryIdentityDevice[] = [],
): DiscoveryIdentity {
  const saved = savedEndpoints.find((entry) => entry.ip === endpoint.ip && entry.port === Number(endpoint.port))
    || savedEndpoints.find((entry) => entry.ip === endpoint.ip);
  const hintedUdid = String(endpoint.udid || saved?.udid || '').trim().toLowerCase();
  const matched = hintedUdid
    ? devices.find((device) => device.id.toLowerCase() === hintedUdid)
    : undefined;
  const rawName = String(endpoint.name || '').trim();
  const name = matched?.name
    || saved?.name
    || (!SERVICE_UUID_NAME.test(rawName) ? rawName : '')
    || endpoint.host
    || endpoint.ip;
  const model = endpoint.model
    || saved?.model
    || (endpoint.ios_version ? `iOS ${endpoint.ios_version}` : '')
    || (endpoint.iosVersion ? `iOS ${endpoint.iosVersion}` : '')
    || matched?.model
    || (matched?.iosVersion ? `iOS ${matched.iosVersion}` : '')
    || '';
  const suffix = formatUdidSuffix(endpoint.udid || saved?.udid || matched?.id);
  return { name, model, suffix };
}

function discoveryIdentity(endpoint: DiscoveryEndpoint): string {
  const udid = String(endpoint.udid || '').trim().toLowerCase();
  if (udid) return `udid:${udid}`;
  const host = String(endpoint.host || '').trim().toLowerCase();
  if (host) return `host:${host}`;
  const name = String(endpoint.name || '').trim().toLowerCase();
  return name ? `name:${name}` : `ip:${String(endpoint.ip || '').trim()}`;
}

/**
 * Collapse discovery duplicates and hide USB/NCM link-local addresses by
 * default.  A phone commonly advertises both 169.254.x.x and its Wi-Fi IP;
 * showing both makes users choose an implementation detail and can select a
 * stale endpoint.  The normal LAN endpoint remains visible.
 */
export function collapseLinkLocalDiscovery<T extends DiscoveryEndpoint>(items: T[]): T[] {
  const valid = items.filter((item) => item && typeof item.ip === 'string' && Number(item.port) > 0);
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of valid) {
    const linkLocal = isLinkLocalIpv4(item.ip);
    const identity = discoveryIdentity(item);
    // Hide link-local entries if there is a normal endpoint for that same
    // phone.  A standalone link-local address is hidden as well: it is not a
    // useful default choice for Wi-Fi setup.
    if (linkLocal) continue;
    const endpointKey = `${item.ip}:${Number(item.port)}`;
    const key = `${identity}|${endpointKey}`;
    // mDNS can report the same endpoint with different presentation names.
    // Keep the first identity record so the picker stays one row per endpoint.
    if (seen.has(endpointKey)) continue;
    if (seen.has(key)) continue;
    seen.add(endpointKey);
    seen.add(key);
    result.push(item);
  }
  return result;
}
