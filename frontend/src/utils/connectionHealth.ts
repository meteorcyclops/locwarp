import type { ConnectionHealth } from '../services/api';

/** Connected device metadata is authoritative over a delayed health event. */
export function reconcileConnectionHealth(
  health: ConnectionHealth | undefined,
  connectedUdid: string | null,
): ConnectionHealth | undefined {
  if (!connectedUdid) return health;
  return {
    ...(health ?? { udid: connectedUdid, usb_disconnects_5m: 0 }),
    udid: connectedUdid,
    state: 'connected',
    is_connected: true,
    retry_in_seconds: undefined,
    retry_at_unix: undefined,
  };
}
