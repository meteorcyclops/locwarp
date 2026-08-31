import { useState, useCallback, useEffect, useRef } from 'react'
import {
  listDevices, connectDevice, disconnectDevice,
  wifiConnect, wifiScan,
  wifiTunnelStartAndConnect, wifiTunnelStatus, wifiTunnelDiscover, wifiTunnelStop,
  type TunnelInfo,
  type ConnectionHealth, getConnectionDiagnostics,
} from '../services/api'
import type { WsMessage } from './useWebSocket'
import {
  buildWifiReconnectEndpoints,
  canonicalUdid,
  isPairingInvalidError,
  isUsableWifiEndpoint,
  networkContextChanged,
  normalizeIpv4,
  sameUdid,
  shouldPersistWifiEndpoint,
  type WifiNetworkContext,
  type WifiReconnectEndpoint,
  type WifiReconnectStatus,
} from '../utils/wifiReconnect'

export type {
  WifiNetworkContext,
  WifiReconnectEndpoint,
  WifiReconnectStage,
  WifiReconnectStatus,
} from '../utils/wifiReconnect'

type ElectronNetworkBridge = {
  getNetworkContext?: () => Promise<WifiNetworkContext | null | undefined>
  onNetworkContextChanged?: (callback: (context: WifiNetworkContext) => void) => () => void
}

function getNetworkBridge(): ElectronNetworkBridge | null {
  if (typeof window === 'undefined' || !window.electronAPI) return null
  return window.electronAPI as unknown as ElectronNetworkBridge
}

function makeWifiError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

// A valid RemotePairing worker can spend up to eight seconds in pair verify,
// and a changed iOS port adds one bounded re-scan.  The old 2.2s controller
// aborted healthy cold starts before the worker could publish its identity.
const SAVED_ENDPOINT_TIMEOUT_MS = 30_000
const DISCOVERY_TIMEOUT_MS = 22_000
const TUNNEL_HANDSHAKE_TIMEOUT_MS = 30_000
const NETWORK_CHANGE_RETRY_DELAY_MS = 300

type ReconnectControllerHandle = {
  controller: AbortController
  cancel: () => void
}

function errorMessage(error: unknown): string {
  const value = error as { message?: unknown } | null | undefined
  return String(value?.message ?? error ?? 'Wi-Fi reconnect failed').slice(0, 240)
}

function createReconnectController(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): ReconnectControllerHandle {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onParentAbort = () => controller.abort()
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  return {
    controller,
    cancel: () => {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', onParentAbort)
    },
  }
}

// The backend may advertise a larger platform-specific limit. Keep the
// legacy macOS one-tunnel fallback until a newer backend explicitly reports
// support for multiple workers; this prevents a short startup race from
// offering a second Wi-Fi tunnel to an old packaged backend.
export const PRODUCT_MAX_TUNNEL_DEVICES = 3
export const DEFAULT_MAX_TUNNEL_DEVICES = typeof window !== 'undefined'
  && window.electronAPI?.platform === 'darwin' ? 1 : 3

function normalizeTunnelCapacity(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TUNNEL_DEVICES
  return Math.min(PRODUCT_MAX_TUNNEL_DEVICES, Math.max(1, Math.floor(n)))
}

export interface DeviceInfo {
  udid: string
  name: string
  ios_version: string
  connection_type: string
  is_connected: boolean
  // iOS 16+ Developer Mode toggle state. null = unknown (iOS <16, query
  // failed, or device not yet connected). Used to decide whether to show
  // the "Reveal Developer Mode option" button.
  developer_mode_enabled?: boolean | null
  // WiFi only: the RemotePairing port the tunnel actually handshook on,
  // which can differ from the requested one when the backend re-scans.
  port?: number
}

export interface WifiScanResult {
  ip: string
  name: string
  udid: string
  ios_version: string
}

export type WsSubscribe = (fn: (m: WsMessage) => void) => () => void

export function useDevice(subscribe?: WsSubscribe) {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [connectedDevice, setConnectedDevice] = useState<DeviceInfo | null>(null)
  const [connectionHealth, setConnectionHealth] = useState<ConnectionHealth[]>([])
  const [wifiNetworkContext, setWifiNetworkContext] = useState<WifiNetworkContext | null>(null)
  const [wifiReconnects, setWifiReconnects] = useState<Record<string, WifiReconnectStatus>>({})
  const networkContextRef = useRef<WifiNetworkContext | null>(null)
  const networkEpochRef = useRef(0)
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map())
  const reconnectAbortControllersRef = useRef<Map<string, Set<AbortController>>>(new Map())
  const wifiScanControllerRef = useRef<AbortController | null>(null)
  const autoConnectControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    const refresh = () => getConnectionDiagnostics()
      .then((result) => { if (active) setConnectionHealth(result.devices || []) })
      .catch(() => {})
    refresh()
    // Health counters are a sliding five-minute window. Polling keeps the
    // displayed count, uptime and stability label accurate even when there
    // are no WebSocket events during a quiet connection.
    const timer = window.setInterval(refresh, 10_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  // React to real-time device state broadcasts via the subscribe callback.
  // See useWebSocket.ts for the rationale vs the old useState pattern.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (msg.type === 'device_disconnected') {
        // Group mode: only mark the specific udid disconnected when provided;
        // fall back to clearing all for legacy single-device disconnect events.
        const udid = msg.data?.udid
        const udids: string[] = Array.isArray(msg.data?.udids) ? msg.data.udids : (udid ? [udid] : [])
        if (udids.length === 0) {
          setConnectedDevice(null)
          setDevices((prev) => prev.map((d) => ({ ...d, is_connected: false })))
          // Also clear the WiFi tunnel list so the 連線 page doesn't keep
          // showing a device that was just disconnected (issue: right-click
          // disconnect left the tunnel chip showing "still connected").
          setTunnels([])
        } else {
          setDevices((prev) => prev.map((d) => udids.includes(d.udid) ? { ...d, is_connected: false } : d))
          setTunnels((prev) => prev.filter((tn) => !udids.includes(tn.udid)))
          // DON'T null out connectedDevice here. The authoritative refresh
          // below (listDevices) will pick a surviving device to promote
          // so downstream UI (MapView / StatusBar) doesn't flash
          // 'No device' in dual-device mode when only one was unplugged.
        }
        // Re-fetch so the sidebar list and metadata stay in sync with the
        // backend, AND promote a surviving connected device as the new
        // active one when the old primary was the one unplugged. This
        // fixes the bug where unplugging A (primary) in dual-device mode
        // made the UI think no device was connected even though B was
        // still alive.
        listDevices().then((list) => {
          setDevices(list)
          setConnectedDevice((prev) => {
            // Keep the current one if it's still connected.
            if (prev && list.some((d) => d.udid === prev.udid && d.is_connected)) return prev
            // Otherwise promote the first surviving connected device.
            return list.find((d) => d.is_connected) ?? null
          })
        }).catch(() => {})
      } else if (msg.type === 'connection_health') {
        const health = msg.data as ConnectionHealth
        if (!health?.udid) return
        setConnectionHealth((prev) => [
          ...prev.filter((item) => item.udid.toLowerCase() !== health.udid.toLowerCase()),
          health,
        ])
      } else if (msg.type === 'device_connected') {
        const connectedUdid = msg.data?.udid
        if (connectedUdid) {
          setConnectionHealth((prev) => {
            const previous = prev.find((item) => item.udid.toLowerCase() === connectedUdid.toLowerCase())
            const connected: ConnectionHealth = {
              ...(previous ?? { udid: connectedUdid, usb_disconnects_5m: 0 }),
              udid: connectedUdid,
              state: 'connected',
              is_connected: true,
              retry_in_seconds: undefined,
              retry_at_unix: undefined,
            }
            return [...prev.filter((item) => item.udid.toLowerCase() !== connectedUdid.toLowerCase()), connected]
          })
        }
        // Re-fetch list so the newly-connected device appears with correct metadata.
        listDevices().then((list) => {
          setDevices(list)
          // If nothing is currently set as the active device, promote the
          // newly-connected one so the bottom panel switches off NODEVICE
          // without the user having to press the USB button.
          const udid = msg.data?.udid
          const match = udid ? list.find((d) => d.udid === udid && d.is_connected) : null
          setConnectedDevice((prev) => prev ?? match ?? list.find((d) => d.is_connected) ?? null)
        }).catch(() => {})
      } else if (msg.type === 'device_reconnected') {
        listDevices().then((list) => {
          setDevices(list)
          const udid = msg.data?.udid
          const match = udid ? list.find((d) => d.udid === udid) : null
          setConnectedDevice(match ?? list.find((d) => d.is_connected) ?? null)
        }).catch(() => {})
      }
    })
  }, [subscribe])
  const [scanning, setScanning] = useState(false)
  const [wifiScanning, setWifiScanning] = useState(false)
  const [wifiDevices, setWifiDevices] = useState<WifiScanResult[]>([])

  const scan = useCallback(async () => {
    setScanning(true)
    try {
      const result = await listDevices()
      const list: DeviceInfo[] = Array.isArray(result) ? result : []
      setDevices(list)
      const active = list.find((d) => d.is_connected) ?? null
      if (active) {
        setConnectedDevice(active)
      } else if (list.length === 1) {
        // Auto-connect when exactly one device is found
        try {
          await connectDevice(list[0].udid)
          const refreshed = await listDevices()
          const rList: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
          setDevices(rList)
          setConnectedDevice(rList.find((d) => d.udid === list[0].udid) ?? list[0])
        } catch {
          setConnectedDevice(null)
        }
      } else {
        setConnectedDevice(null)
      }
      return list
    } catch (err) {
      console.error('Failed to scan devices:', err)
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  const connect = useCallback(
    async (udid: string) => {
      try {
        await connectDevice(udid)
        const refreshed = await listDevices()
        const list: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
        setDevices(list)
        const active = list.find((d) => d.udid === udid) ?? null
        setConnectedDevice(active)
        return active
      } catch (err) {
        console.error('Failed to connect device:', err)
        throw err
      }
    },
    [],
  )

  const disconnect = useCallback(
    async (udid: string) => {
      try {
        await disconnectDevice(udid)
        const refreshed = await listDevices()
        const list: DeviceInfo[] = Array.isArray(refreshed) ? refreshed : []
        setDevices(list)
        // Only the named device was disconnected — DON'T blanket-null the
        // active device. In dual/triple mode that made the whole UI flip to
        // "NO device" even though the other iPhones were still connected.
        // Keep the current active device if it survived; otherwise promote
        // any remaining connected one; null only when nothing is left.
        setConnectedDevice((prev) => {
          if (prev && prev.udid !== udid && list.some((d) => d.udid === prev.udid && d.is_connected)) return prev
          return list.find((d) => d.is_connected) ?? null
        })
        setTunnels((prev) => prev.filter((tn) => tn.udid !== udid))
      } catch (err) {
        console.error('Failed to disconnect device:', err)
        throw err
      }
    },
    [],
  )

  const connectWifi = useCallback(
    async (ip: string) => {
      try {
        const res = await wifiConnect(ip)
        const info: DeviceInfo = {
          udid: res.udid,
          name: res.name,
          ios_version: res.ios_version,
          connection_type: 'Network',
          is_connected: true,
        }
        // Adding a second Wi-Fi tunnel must not steal the sticky primary
        // device. Explicit device selection still goes through connect(),
        // while background/group connects only promote when there is no
        // surviving active device.
        setConnectedDevice((prev) => prev && prev.is_connected ? prev : info)
        setDevices((prev) => {
          const filtered = prev.filter((d) => d.udid !== info.udid)
          return [...filtered, info]
        })
        return info
      } catch (err) {
        console.error('WiFi connect failed:', err)
        throw err
      }
    },
    [],
  )

  const scanWifi = useCallback(async () => {
    wifiScanControllerRef.current?.abort()
    const controller = new AbortController()
    wifiScanControllerRef.current = controller
    setWifiScanning(true)
    try {
      const results = await wifiScan(controller.signal)
      if (controller.signal.aborted || wifiScanControllerRef.current !== controller) return []
      const list: WifiScanResult[] = Array.isArray(results) ? results : []
      setWifiDevices(list)
      return list
    } catch (err) {
      if (controller.signal.aborted) return []
      console.error('WiFi scan failed:', err)
      return []
    } finally {
      if (wifiScanControllerRef.current === controller) {
        wifiScanControllerRef.current = null
        setWifiScanning(false)
      }
    }
  }, [])

  // v0.2.83: WiFi tunnel state went from a singleton to a per-device list.
  // Each connected iOS 17+ WiFi device gets its own runner on the backend;
  // `tunnels` mirrors that list. `tunnelStatus` is kept as a derived
  // singleton (mirrors first tunnel) for any leftover single-tunnel callers
  // until they migrate.
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([])
  const [maxTunnelDevices, setMaxTunnelDevices] = useState(DEFAULT_MAX_TUNNEL_DEVICES)
  const devicesRef = useRef<DeviceInfo[]>(devices)
  devicesRef.current = devices
  const maxTunnelDevicesRef = useRef(maxTunnelDevices)
  maxTunnelDevicesRef.current = maxTunnelDevices
  const tunnelStatus = tunnels.length > 0
    ? { running: true, rsd_address: tunnels[0].rsd_address, rsd_port: tunnels[0].rsd_port }
    : { running: false }

  // Keep tunnel count/capacity authoritative even when the app was started
  // after the backend had already restored one or more Wi-Fi workers. Older
  // macOS backends omit max_devices and still support only one worker, so the
  // platform-aware fallback remains in force until a newer status response is
  // available.
  useEffect(() => {
    let active = true
    const refreshTunnelStatus = async () => {
      try {
        const res = await wifiTunnelStatus()
        if (!active) return
        setTunnels(Array.isArray(res?.tunnels) ? res.tunnels : [])
        if (res?.max_devices != null) {
          setMaxTunnelDevices(normalizeTunnelCapacity(res.max_devices))
        }
      } catch {
        // The backend may still be starting; lifecycle events and the next
        // poll will reconcile the list without disturbing local state.
      }
    }
    void refreshTunnelStatus()
    const timer = window.setInterval(refreshTunnelStatus, 10_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  // ── Pin & auto-reconnect (issue #33) ──────────────────────────────
  // A pinned device keeps trying to reconnect on its own after the
  // backend watchdog gives up (tunnel_lost). The backend already retries
  // 3x with backoff for transient blips; this covers the longer outages
  // (phone opened late, left the WiFi for a while) the user has to fix by
  // hand today. State is persisted so a pin survives an app restart.
  const PIN_KEY = 'locwarp.tunnel.pinned'
  const readPinned = (): string[] => {
    try {
      const arr = JSON.parse(localStorage.getItem(PIN_KEY) || '[]')
      if (!Array.isArray(arr)) return []
      const result: string[] = []
      for (const value of arr) {
        if (typeof value !== 'string' || !value.trim()) continue
        // Keep the first spelling for the UI, but de-duplicate identities
        // case-insensitively for reconnect scheduling.
        if (!result.some((existing) => sameUdid(existing, value))) result.push(value.trim())
      }
      return result
    } catch { return [] }
  }
  const [pinnedUdids, setPinnedUdids] = useState<string[]>(readPinned)
  const pinnedRef = useRef<string[]>(pinnedUdids)
  pinnedRef.current = pinnedUdids
  const tunnelsRef = useRef<TunnelInfo[]>(tunnels)
  tunnelsRef.current = tunnels
  const pinRetryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const pinReconnectInFlightRef = useRef<Set<string>>(new Set())
  const reconnectInFlightEpochRef = useRef<Map<string, number>>(new Map())
  // Set after startWifiTunnel is defined below; the retry loop calls
  // through the ref so we avoid a definition-order cycle.
  const startWifiTunnelRef = useRef<((ip: string, port?: number, udidHint?: string, portHints?: number[], signal?: AbortSignal, rescan?: boolean) => Promise<any>) | null>(null)

  const updateWifiReconnect = useCallback((
    udid: string,
    stage: WifiReconnectStatus['stage'],
    details: Partial<WifiReconnectStatus> = {},
  ) => {
    const key = canonicalUdid(udid)
    if (!key) return
    setWifiReconnects((previous) => {
      const existing = previous[key]
      const attempt = details.attempt ?? existing?.attempt ?? reconnectAttemptsRef.current.get(key) ?? 0
      return {
        ...previous,
        [key]: {
          udid: details.udid ?? existing?.udid ?? udid,
          stage,
          attempt,
          networkSignature: details.networkSignature ?? existing?.networkSignature ?? networkContextRef.current?.signature,
          updatedAt: Date.now(),
          ...details,
        },
      }
    })
  }, [])

  const trackReconnectController = useCallback((udid: string, controller: AbortController) => {
    const key = canonicalUdid(udid)
    const controllers = reconnectAbortControllersRef.current.get(key) ?? new Set<AbortController>()
    controllers.add(controller)
    reconnectAbortControllersRef.current.set(key, controllers)
    return () => {
      controllers.delete(controller)
      if (controllers.size === 0) reconnectAbortControllersRef.current.delete(key)
    }
  }, [])

  const hasConnectedUdid = (udid: string): boolean =>
    devicesRef.current.some((device) => sameUdid(device.udid, udid) && device.is_connected)

  const hasTunnelUdid = (udid: string): boolean =>
    tunnelsRef.current.some((tunnel) => sameUdid(tunnel.udid, udid))

  const clearPinRetry = useCallback((udid: string) => {
    const key = canonicalUdid(udid)
    const tmr = pinRetryTimers.current[key]
    if (tmr) { clearTimeout(tmr); delete pinRetryTimers.current[key] }
  }, [])

  const readSavedEntryFor = (udid: string): WifiReconnectEndpoint | null => {
    try {
      const arr = JSON.parse(localStorage.getItem('locwarp.tunnel.savedips') || '[]')
      if (!Array.isArray(arr)) return null
      const hit = arr.find((e: any) => e && sameUdid(e.udid, udid) && typeof e.ip === 'string')
      if (hit) {
        return {
          ip: hit.ip,
          port: Number(hit.port) || 49152,
          udid: hit.udid,
          name: typeof hit.name === 'string' ? hit.name : undefined,
        }
      }
    } catch { /* ignore */ }
    return null
  }

  const schedulePinReconnect = useCallback((udid: string, delayMs = 5000) => {
    const key = canonicalUdid(udid)
    if (!key || pinRetryTimers.current[key]) return // already scheduled
    const attempt = async () => {
      delete pinRetryTimers.current[key]
      // Stop if the user unpinned, the device/tunnel already came back, or a
      // prior retry for this UDID is still handshaking.
      if (!pinnedRef.current.some((pinned) => sameUdid(pinned, key))) return
      if (pinReconnectInFlightRef.current.has(key)) {
        // A previous attempt may belong to a network epoch that was just
        // cancelled. Let the new epoch take the slot, while its finally block
        // is prevented from deleting the new attempt's reservation below.
        if (reconnectInFlightEpochRef.current.get(key) === networkEpochRef.current) return
        pinReconnectInFlightRef.current.delete(key)
        reconnectInFlightEpochRef.current.delete(key)
      }
      if (hasConnectedUdid(key) || hasTunnelUdid(key)) {
        updateWifiReconnect(key, 'connected')
        return
      }

      // Respect the backend-advertised worker capacity. In-flight pin
      // retries reserve slots as well, preventing a 15s timer storm from
      // creating duplicate workers while another device is reconnecting.
      const capacity = Math.max(1, Math.min(PRODUCT_MAX_TUNNEL_DEVICES, Math.floor(Number(maxTunnelDevicesRef.current) || DEFAULT_MAX_TUNNEL_DEVICES)))
      const occupiedCount = new Set([
        ...devicesRef.current.filter((device) => device.is_connected).map((device) => canonicalUdid(device.udid)),
        ...tunnelsRef.current.map((tunnel) => canonicalUdid(tunnel.udid)),
      ].filter(Boolean)).size
      if (occupiedCount + pinReconnectInFlightRef.current.size >= capacity) {
        schedulePinReconnect(key, 15000)
        return
      }

      const epoch = networkEpochRef.current
      const networkSignature = networkContextRef.current?.signature
      const attemptNumber = (reconnectAttemptsRef.current.get(key) ?? 0) + 1
      reconnectAttemptsRef.current.set(key, attemptNumber)
      pinReconnectInFlightRef.current.add(key)
      reconnectInFlightEpochRef.current.set(key, epoch)
      let success = false
      let pairingInvalid = false
      let lastError = ''

      const epochCurrent = () =>
        networkEpochRef.current === epoch
        && pinnedRef.current.some((pinned) => sameUdid(pinned, key))
      const current = () =>
        epochCurrent()
        && !hasConnectedUdid(key)
        && !hasTunnelUdid(key)

      const tryEndpoint = async (
        endpoint: WifiReconnectEndpoint,
        stage: WifiReconnectStatus['stage'],
        timeoutMs: number,
      ): Promise<'connected' | 'retry' | 'stale' | 'repair'> => {
        if (!current() || !startWifiTunnelRef.current) return 'stale'
        updateWifiReconnect(key, stage, {
          attempt: attemptNumber,
          ip: endpoint.ip,
          name: endpoint.name,
          error: undefined,
          requiresUsbRepair: false,
          networkSignature,
        })
        const request = createReconnectController(timeoutMs)
        const untrack = trackReconnectController(key, request.controller)
        try {
          await startWifiTunnelRef.current(
            endpoint.ip,
            endpoint.port,
            key,
            endpoint.ports,
            request.controller.signal,
            stage !== 'tunnel',
          )
          // A successful start mutates the connected/tunnel stores.  At this
          // point that is the desired result, not evidence that the attempt
          // became stale; only an epoch/pin change may invalidate it.
          if (!epochCurrent() || request.controller.signal.aborted) return 'stale'
          success = true
          updateWifiReconnect(key, 'connected', {
            attempt: attemptNumber,
            ip: endpoint.ip,
            name: endpoint.name,
            networkSignature,
          })
          return 'connected'
        } catch (error) {
          if (networkEpochRef.current !== epoch || !pinnedRef.current.some((pinned) => sameUdid(pinned, key))) {
            return 'stale'
          }
          if (isPairingInvalidError(error)) {
            pairingInvalid = true
            lastError = errorMessage(error)
            updateWifiReconnect(key, 'needs_usb_repair', {
              attempt: attemptNumber,
              ip: endpoint.ip,
              name: endpoint.name,
              error: lastError,
              requiresUsbRepair: true,
              networkSignature,
            })
            return 'repair'
          }
          // An endpoint timeout is deliberately treated as a normal fallback
          // failure. A network-epoch abort, by contrast, must never continue
          // with an old IP; the caller checks the epoch before proceeding.
          lastError = errorMessage(error)
          return 'retry'
        } finally {
          request.cancel()
          untrack()
        }
      }

      try {
        const saved = readSavedEntryFor(udid)
        // The remembered endpoint gets one short probe first. Do not open a
        // socket for an old subnet, a link-local address, or an endpoint
        // explicitly marked unreachable by discovery.
        if (saved && isUsableWifiEndpoint(saved, networkContextRef.current)) {
          const savedResult = await tryEndpoint(saved, 'last_ip', SAVED_ENDPOINT_TIMEOUT_MS)
          if (savedResult === 'connected' || savedResult === 'repair' || savedResult === 'stale') return
        }

        if (!current()) return
        updateWifiReconnect(key, 'network_changed_discovery', {
          attempt: attemptNumber,
          error: undefined,
          requiresUsbRepair: false,
          networkSignature,
        })
        const discovery = createReconnectController(DISCOVERY_TIMEOUT_MS)
        const untrackDiscovery = trackReconnectController(key, discovery.controller)
        let discovered: WifiReconnectEndpoint[] = []
        try {
          const result = await wifiTunnelDiscover(discovery.controller.signal)
          if (current() && !discovery.controller.signal.aborted) {
            discovered = (result?.devices || []).map((candidate) => ({
              ip: candidate.ip,
              port: candidate.port,
              ports: candidate.ports,
              udid: candidate.udid,
              name: candidate.name,
              host: candidate.host,
              reachable: candidate.reachable,
              unreachable: candidate.unreachable,
            }))
          }
        } catch (error) {
          if (networkEpochRef.current !== epoch) return
          lastError = errorMessage(error)
        } finally {
          discovery.cancel()
          untrackDiscovery()
        }
        if (!current()) return

        const endpoints = buildWifiReconnectEndpoints(key, null, discovered, networkContextRef.current)
        for (const endpoint of endpoints) {
          if (!current()) return
          if (endpoint.name || endpoint.host) {
            updateWifiReconnect(key, 'found_name', {
              attempt: attemptNumber,
              ip: endpoint.ip,
              name: endpoint.name || endpoint.host,
              networkSignature,
            })
          }
          const endpointResult = await tryEndpoint(endpoint, 'tunnel', TUNNEL_HANDSHAKE_TIMEOUT_MS)
          if (endpointResult === 'connected' || endpointResult === 'repair' || endpointResult === 'stale') return
        }
      } finally {
        if (reconnectInFlightEpochRef.current.get(key) === epoch) {
          pinReconnectInFlightRef.current.delete(key)
          reconnectInFlightEpochRef.current.delete(key)
        }
        if (!success && !pairingInvalid && current()) {
          updateWifiReconnect(key, 'failed', {
            attempt: attemptNumber,
            error: lastError || '找不到可用的 Wi-Fi endpoint',
            requiresUsbRepair: false,
            networkSignature,
          })
          schedulePinReconnect(key, 15000)
        }
      }
    }
    pinRetryTimers.current[key] = setTimeout(attempt, delayMs)
  }, [trackReconnectController, updateWifiReconnect])

  const PIN_IP_MAP_KEY = 'locwarp.tunnel.pin_ip_map'

  const togglePin = useCallback((udid: string) => {
    const key = canonicalUdid(udid)
    if (!key) return
    setPinnedUdids((prev) => {
      const isPinned = prev.some((pinned) => sameUdid(pinned, key))
      const next = isPinned
        ? prev.filter((pinned) => !sameUdid(pinned, key))
        : [...prev, udid.trim()]
      try { localStorage.setItem(PIN_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      if (!next.some((pinned) => sameUdid(pinned, key))) {
        clearPinRetry(key)
        // Remove IP mapping when unpinning so the device is no longer
        // auto-connected on next startup (issue #35).
        try {
          const map = JSON.parse(localStorage.getItem(PIN_IP_MAP_KEY) || '{}')
          delete map[key]
          localStorage.setItem(PIN_IP_MAP_KEY, JSON.stringify(map))
        } catch { /* ignore */ }
      } else {
        // Save last known IP when pinning so startup auto-connect can
        // filter to pinned devices only (issue #35).
        const entry = readSavedEntryFor(key)
        if (entry) {
          try {
            const map = JSON.parse(localStorage.getItem(PIN_IP_MAP_KEY) || '{}')
            map[key] = `${entry.ip}:${entry.port}`
            localStorage.setItem(PIN_IP_MAP_KEY, JSON.stringify(map))
          } catch { /* ignore */ }
        }
      }
      return next
    })
  }, [clearPinRetry])

  // Drive pin retries off the tunnel lifecycle events. Kept separate from
  // the panel-state handler above so ordering / deps stay simple.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (msg.type === 'tunnel_lost') {
        const udid = msg.data?.udid
        if (udid && pinnedRef.current.some((pinned) => sameUdid(pinned, udid))) schedulePinReconnect(udid)
      } else if (msg.type === 'tunnel_recovered' || msg.type === 'device_connected') {
        const udid = msg.data?.udid
        if (udid) clearPinRetry(udid)
      }
    })
  }, [subscribe, schedulePinReconnect, clearPinRetry])

  // React to backend tunnel lifecycle events so the DeviceStatus panel
  // doesn't keep showing a dead tunnel as connected when the iPhone
  // leaves the WiFi network. Without this, the `tunnels` list is only
  // mutated by explicit Start / Stop button clicks — issue #29.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (msg.type === 'tunnel_lost') {
        const udid = msg.data?.udid
        if (udid) {
          setTunnels((prev) => prev.filter((tn) => tn.udid !== udid))
          setDevices((prev) => prev.map((d) =>
            d.udid === udid && d.connection_type === 'Network'
              ? { ...d, is_connected: false }
              : d,
          ))
        } else {
          // No udid in the payload — fall back to a full re-query so
          // we never leave a phantom tunnel chip in the panel.
          wifiTunnelStatus().then((res) => {
            setTunnels(Array.isArray(res?.tunnels) ? res.tunnels : [])
          }).catch(() => setTunnels([]))
        }
      } else if (msg.type === 'tunnel_recovered') {
        const udid = msg.data?.udid
        const rsd_address = msg.data?.rsd_address
        const rsd_port = msg.data?.rsd_port
        if (udid && rsd_address && typeof rsd_port === 'number') {
          setTunnels((prev) => {
            const filtered = prev.filter((tn) => tn.udid !== udid)
            return [...filtered, { udid, rsd_address, rsd_port }]
          })
        }
      }
    })
  }, [subscribe])

  const startWifiTunnel = useCallback(
    async (ip: string, port = 49152, udidHint?: string, portHints?: number[], signal?: AbortSignal, rescan = true) => {
      try {
        if (signal?.aborted) throw makeWifiError('network_changed', 'Wi-Fi network changed')
        const contextAtStart = networkContextRef.current
        const res = await wifiTunnelStartAndConnect(ip, port, udidHint, portHints, signal, rescan)
        if (signal?.aborted) throw makeWifiError('network_changed', 'Wi-Fi network changed')
        const actualUdid = canonicalUdid(res?.udid)
        if (!actualUdid) throw makeWifiError('udid_missing', 'Tunnel did not report a device identity')
        if (udidHint && !sameUdid(udidHint, actualUdid)) {
          throw makeWifiError('udid_mismatch', 'Tunnel identity did not match the requested device')
        }
        if (res?.max_devices != null) {
          setMaxTunnelDevices(normalizeTunnelCapacity(res.max_devices))
        }
        // The backend re-scans and may land on a different port than the one
        // we asked for (iOS re-picks RemotePairing on every boot). Remember
        // what actually worked, not what we guessed.
        const usedPort = Number(res.port) > 0 ? Number(res.port) : port
        const info: DeviceInfo = {
          udid: res.udid,
          name: res.name,
          ios_version: res.ios_version,
          connection_type: 'Network',
          is_connected: true,
        }
        // A parallel group connect should retain the current primary. The
        // first successful worker becomes primary only when no device was
        // active yet; subsequent workers stay visible in connectedDevices.
        setConnectedDevice((prev) => prev && prev.is_connected ? prev : info)
        setDevices((prev) => {
          const filtered = prev.filter((d) => !sameUdid(d.udid, info.udid))
          return [...filtered, info]
        })
        setTunnels((prev) => {
          const filtered = prev.filter((tn) => !sameUdid(tn.udid, actualUdid))
          return [...filtered, {
            udid: res.udid,
            rsd_address: res.rsd_address,
            rsd_port: res.rsd_port,
          }]
        })
        // Persist only an endpoint whose peer identity was returned by the
        // backend and whose address still belongs to the current LAN. This
        // prevents an IP-only Bonjour result, a stale DHCP address, or a
        // link-local interface from poisoning the next reconnect attempt.
        try {
          const persistedIp = normalizeIpv4(res?.ip) ?? normalizeIpv4(ip)
          const saveEndpoint: WifiReconnectEndpoint | null = persistedIp
            ? { ip: persistedIp, port: usedPort, udid: actualUdid, name: res.name }
            : null
          if (saveEndpoint && shouldPersistWifiEndpoint(udidHint, actualUdid, saveEndpoint, contextAtStart)) {
            const raw = localStorage.getItem('locwarp.tunnel.savedips') || '[]'
            const list = (() => {
              try { return JSON.parse(raw) as Array<{ ip: string; port: number; udid?: string; name?: string; lastUsed: number }> }
              catch { return [] }
            })()
            const baseList = Array.isArray(list) ? list : []
            const filtered = baseList.filter((entry) =>
              entry && !sameUdid(entry.udid, actualUdid)
              && !(normalizeIpv4(entry.ip) === saveEndpoint.ip && Number(entry.port) === usedPort)
            )
            const next = [{
              ip: saveEndpoint.ip,
              port: usedPort,
              udid: actualUdid,
              name: res.name,
              lastUsed: Date.now(),
            }, ...filtered].slice(0, 5)
            localStorage.setItem('locwarp.tunnel.savedips', JSON.stringify(next))
          }
        } catch { /* storage disabled */ }
        // A successful connect clears any pending pin-retry for this device.
        clearPinRetry(actualUdid)
        return { ...info, port: usedPort }
      } catch (err) {
        console.error('WiFi tunnel failed:', err)
        throw err
      }
    },
    [],
  )
  // Expose the latest startWifiTunnel to the pin-retry loop without making
  // it a hook dependency (the callback is stable, deps: []).
  startWifiTunnelRef.current = startWifiTunnel

  // Backend startup can restore a device before the renderer subscribes to
  // its connected event. Reconcile transient UI stages against the current
  // authoritative device/tunnel snapshots so a successful reconnect never
  // remains labelled as discovery or failure.
  useEffect(() => {
    const connectedKeys = new Set([
      ...devices.filter((item) => item.is_connected).map((item) => canonicalUdid(item.udid)),
      ...tunnels.map((item) => canonicalUdid(item.udid)),
    ].filter(Boolean))
    if (connectedKeys.size === 0) return
    setWifiReconnects((previous) => {
      let changed = false
      const next = { ...previous }
      for (const key of connectedKeys) {
        const status = next[key]
        if (!status || status.stage === 'connected') continue
        next[key] = { ...status, stage: 'connected', error: undefined, requiresUsbRepair: false, updatedAt: Date.now() }
        changed = true
      }
      return changed ? next : previous
    })
  }, [devices, tunnels])

  // The renderer does not own the network interface, but it does own the
  // retry work.  A network epoch makes every in-flight saved-IP/discovery
  // attempt stale as soon as macOS moves to another interface or subnet.
  // This is intentionally placed after schedulePinReconnect so a change can
  // immediately queue the pinned UDIDs on the new network.
  useEffect(() => {
    const bridge = getNetworkBridge()
    if (!bridge) return
    let active = true

    const applyNetworkContext = (next: WifiNetworkContext | null | undefined) => {
      if (!active || !next) return
      const previous = networkContextRef.current
      const changed = networkContextChanged(previous, next)
      networkContextRef.current = next
      setWifiNetworkContext(next)
      if (!changed) return

      networkEpochRef.current += 1
      wifiScanControllerRef.current?.abort()
      autoConnectControllerRef.current?.abort()
      for (const controllers of reconnectAbortControllersRef.current.values()) {
        for (const controller of controllers) controller.abort()
      }
      for (const key of Object.keys(pinRetryTimers.current)) clearPinRetry(key)
      // Do not tear down an already-healthy tunnel here.  Only missing pins
      // are rescheduled; the backend watchdog owns live socket recovery.
      for (const udid of pinnedRef.current) schedulePinReconnect(udid, NETWORK_CHANGE_RETRY_DELAY_MS)
    }

    const unsubscribe = bridge.onNetworkContextChanged?.(applyNetworkContext)
    const initialContext = bridge.getNetworkContext?.()
    if (initialContext) {
      void initialContext.then((context) => applyNetworkContext(context))
        .catch(() => { /* Electron bridge may be unavailable during startup */ })
    }

    return () => {
      active = false
      unsubscribe?.()
      autoConnectControllerRef.current?.abort()
      wifiScanControllerRef.current?.abort()
      for (const controllers of reconnectAbortControllersRef.current.values()) {
        for (const controller of controllers) controller.abort()
      }
      for (const key of Object.keys(pinRetryTimers.current)) clearPinRetry(key)
    }
  }, [clearPinRetry, schedulePinReconnect])

  const autoConnectWifi = useCallback(async (): Promise<void> => {
    let enabled = true
    try { enabled = localStorage.getItem('locwarp.tunnel.autoconnect') !== '0' } catch { /* ignore */ }
    if (!enabled) return

    autoConnectControllerRef.current?.abort()
    const controller = new AbortController()
    autoConnectControllerRef.current = controller
    const epoch = networkEpochRef.current
    const current = () => networkEpochRef.current === epoch && !controller.signal.aborted

    try {
      // The event subscription normally populates this first. Awaiting the
      // bridge here also makes cold-start deterministic when the websocket
      // becomes ready before Electron's first network poll.
      if (!networkContextRef.current) {
        const context = await getNetworkBridge()?.getNetworkContext?.()
        if (context && current()) {
          networkContextRef.current = context
          setWifiNetworkContext(context)
        }
      }
      if (!current()) return

      const [statusResult, devicesResult] = await Promise.allSettled([
        wifiTunnelStatus(controller.signal),
        listDevices(controller.signal),
      ])
      if (!current()) return
      const status = statusResult.status === 'fulfilled'
        ? statusResult.value
        : { tunnels: [] as TunnelInfo[], max_devices: undefined }
      const listedDevices = devicesResult.status === 'fulfilled' && Array.isArray(devicesResult.value)
        ? devicesResult.value
        : []
      const activeTunnels = Array.isArray(status.tunnels) ? status.tunnels : []
      // Keep refs in lock-step for the immediate pass; React state will cause
      // the normal render/poll reconciliation afterwards.
      tunnelsRef.current = activeTunnels
      setTunnels(activeTunnels)
      const advertisedMax = Number((status as { max_devices?: unknown }).max_devices)
      const maxDevices = Number.isFinite(advertisedMax) && advertisedMax > 0
        ? Math.min(PRODUCT_MAX_TUNNEL_DEVICES, Math.max(1, Math.floor(advertisedMax)))
        : Math.min(PRODUCT_MAX_TUNNEL_DEVICES, Math.max(1, Number(maxTunnelDevicesRef.current) || DEFAULT_MAX_TUNNEL_DEVICES))
      if (Number.isFinite(advertisedMax) && advertisedMax > 0) setMaxTunnelDevices(maxDevices)

      const occupiedUdids = new Set<string>()
      for (const device of listedDevices) {
        if (device?.is_connected && device.udid) occupiedUdids.add(canonicalUdid(device.udid))
      }
      for (const tunnel of activeTunnels) {
        if (tunnel?.udid) occupiedUdids.add(canonicalUdid(tunnel.udid))
      }

      const saved: WifiReconnectEndpoint[] = []
      try {
        const raw = JSON.parse(localStorage.getItem('locwarp.tunnel.savedips') || '[]')
        if (Array.isArray(raw)) {
          for (const entry of raw) {
            if (!entry || typeof entry.ip !== 'string') continue
            saved.push({
              ip: entry.ip,
              port: Number(entry.port) || 49152,
              udid: typeof entry.udid === 'string' ? entry.udid : undefined,
              name: typeof entry.name === 'string' ? entry.name : undefined,
            })
          }
        }
      } catch { /* ignore malformed savedips */ }
      // Keep the pre-multi-device single-IP preference as a one-entry
      // migration fallback. It still goes through the same subnet/link-local
      // validator before any connection attempt.
      if (saved.length === 0) {
        try {
          const legacyIp = localStorage.getItem('locwarp.tunnel.ip') || ''
          if (legacyIp.trim()) {
            saved.push({
              ip: legacyIp,
              port: Number(localStorage.getItem('locwarp.tunnel.port')) || 49152,
            })
          }
        } catch { /* ignore legacy storage */ }
      }

      const pinned = Array.from(new Set(pinnedRef.current.map(canonicalUdid).filter(Boolean)))
      const availableSlots = Math.max(0, maxDevices - occupiedUdids.size)
      if (pinned.length > 0) {
        // Reuse the same per-UDID transaction used for long-outage retries.
        // Scheduling all missing pins is safe: each timer reserves its own
        // slot and different UDIDs can handshake in parallel.
        let scheduled = 0
        for (const udid of pinned) {
          if (occupiedUdids.has(udid) || scheduled >= availableSlots) continue
          scheduled += 1
          schedulePinReconnect(udid, 0)
        }
        return
      }

      const discovery = createReconnectController(DISCOVERY_TIMEOUT_MS, controller.signal)
      let discovered: WifiReconnectEndpoint[] = []
      try {
        const result = await wifiTunnelDiscover(discovery.controller.signal)
        if (current() && !discovery.controller.signal.aborted) {
          discovered = (result?.devices || []).map((candidate) => ({
            ip: candidate.ip,
            port: candidate.port,
            ports: candidate.ports,
            udid: candidate.udid,
            name: candidate.name,
            host: candidate.host,
            reachable: candidate.reachable,
            unreachable: candidate.unreachable,
          }))
        }
      } catch { /* saved entries may still be usable */ }
      discovery.cancel()
      if (!current()) return

      const endpoints = buildWifiReconnectEndpoints(
        '',
        null,
        [...saved, ...discovered],
        networkContextRef.current,
      ).filter((endpoint) => !endpoint.udid || !occupiedUdids.has(canonicalUdid(endpoint.udid)))
      if (endpoints.length === 0 || availableSlots === 0) return

      // Group known endpoints by identity so the same phone cannot receive
      // parallel starts. IP-only candidates remain individually addressable;
      // the backend's response identity is still required before saving.
      const groups = new Map<string, WifiReconnectEndpoint[]>()
      for (const endpoint of endpoints) {
        const key = endpoint.udid ? `udid:${canonicalUdid(endpoint.udid)}` : `ip:${endpoint.ip}:${endpoint.port}`
        const group = groups.get(key) ?? []
        group.push(endpoint)
        groups.set(key, group)
      }
      const selectedGroups = Array.from(groups.values()).slice(0, availableSlots)
      await Promise.allSettled(selectedGroups.map(async (group) => {
        for (const endpoint of group) {
          if (!current()) return
          const request = createReconnectController(TUNNEL_HANDSHAKE_TIMEOUT_MS, controller.signal)
          try {
            await startWifiTunnel(
              endpoint.ip,
              endpoint.port,
              endpoint.udid,
              endpoint.ports,
              request.controller.signal,
            )
            return
          } catch {
            // Try the next endpoint for this identity, if discovery supplied
            // more than one port/address.
          } finally {
            request.cancel()
          }
        }
      }))
    } finally {
      if (autoConnectControllerRef.current === controller) autoConnectControllerRef.current = null
    }
  }, [schedulePinReconnect, startWifiTunnel])

  const checkTunnelStatus = useCallback(async () => {
    try {
      const res = await wifiTunnelStatus()
      setTunnels(Array.isArray(res?.tunnels) ? res.tunnels : [])
      if (res?.max_devices != null) {
        setMaxTunnelDevices(normalizeTunnelCapacity(res.max_devices))
      }
      return res
    } catch {
      setTunnels([])
      return { tunnels: [], running: false }
    }
  }, [])

  // udid: stop one specific tunnel; omit to stop all.
  const stopTunnel = useCallback(async (udid?: string) => {
    try {
      await wifiTunnelStop(udid)
      if (udid) {
        setTunnels((prev) => prev.filter((tn) => tn.udid !== udid))
      } else {
        setTunnels([])
      }
    } catch (err) {
      console.error('Failed to stop tunnel:', err)
    }
  }, [])

  // Group-mode derived state: every device in `devices` marked is_connected.
  // `primaryDevice` sticks to whichever device we picked first; we only
  // promote a new one when the current sticky primary is no longer in the
  // connected slice. Without stickiness, listDevices()'s order on a
  // mid-session reconnect can swap primary back to the just-rejoined
  // device, which then receives the auto-sync replay (a fresh sim from
  // its current position) and the frontend lets that REPLAY's events
  // through the udid filter, overwriting the surviving device's polyline
  // and "瞬移回起點 / 慢慢走回起點" on screen. Sticky primary keeps the
  // surviving device in charge so the rejoining one's replay stays
  // filtered out and invisible until the user explicitly chooses to
  // switch.
  const connectedDevices: DeviceInfo[] = devices.filter((d) => d.is_connected)
  const [stickyPrimaryUdid, setStickyPrimaryUdid] = useState<string | null>(null)
  useEffect(() => {
    if (connectedDevices.length === 0) {
      if (stickyPrimaryUdid !== null) setStickyPrimaryUdid(null)
      return
    }
    if (stickyPrimaryUdid && connectedDevices.some((d) => d.udid === stickyPrimaryUdid)) {
      return
    }
    setStickyPrimaryUdid(connectedDevices[0].udid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices])
  const primaryDevice: DeviceInfo | null =
    devices.find((d) => d.udid === stickyPrimaryUdid && d.is_connected) ?? null

  return {
    devices, connectedDevice, scanning, scan, connect, disconnect,
    connectWifi, scanWifi, wifiScanning, wifiDevices,
    startWifiTunnel, checkTunnelStatus, stopTunnel, tunnelStatus, tunnels,
    maxTunnelDevices,
    connectedDevices, primaryDevice,
    pinnedUdids, togglePin,
    connectionHealth,
    wifiNetworkContext, wifiReconnects, autoConnectWifi,
  }
}
