import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { wifiTunnelDiscover, wifiTunnelFindPort, wifiRepair, wifiKeepaliveGet, wifiKeepaliveSet, mountPersonalizedDdi, type TunnelInfo, type ConnectionHealth } from '../services/api';
import { useT } from '../i18n';
import { reconcileConnectionHealth } from '../utils/connectionHealth';
import type { GroupSyncStatus } from '../hooks/useSimulation';
import { canonicalUdid, type WifiReconnectStatus } from '../utils/wifiReconnect';
import {
  collapseLinkLocalDiscovery,
  countGpsReady,
  formatUdidSuffix,
  getDeviceProgress,
  getDeviceStage,
  getDeviceTransport,
  resolveDiscoveryIdentity,
  type DeviceStage,
  type DeviceProgressStep,
  type DeviceProgressState,
  type DeviceTransport,
  type DiscoveryEndpoint,
} from '../utils/deviceStatus';

// The backend advertises the actual platform capability. Until that response
// arrives, preserve the old macOS one-tunnel fallback so an old packaged
// backend cannot be offered a second worker and then return 409.
const PRODUCT_MAX_TUNNEL_DEVICES = 3;
const DEFAULT_MAX_TUNNEL_DEVICES = typeof window !== 'undefined'
  && window.electronAPI?.platform === 'darwin' ? 1 : 3;

interface Device {
  id: string;
  name: string;
  iosVersion: string;
  model?: string;
  connectionType?: string;
  isConnected?: boolean;
  developerModeEnabled?: boolean | null;
}

interface TunnelStatus {
  running: boolean;
  rsd_address?: string;
  rsd_port?: number;
}

interface DeviceStatusProps {
  device: Device | null;
  devices: Device[];
  isConnected: boolean;
  onScan: () => void | Promise<void>;
  onSelect: (id: string) => void;
  onStartWifiTunnel?: (ip: string, port?: number, udid?: string, ports?: number[]) => Promise<any>;
  onStopTunnel?: (udid?: string) => Promise<void>;
  tunnelStatus?: TunnelStatus;
  tunnels?: TunnelInfo[];
  onWifiConnect?: (ip: string) => Promise<any>;
  pinnedUdids?: string[];
  onTogglePin?: (udid: string) => void;
  connectionHealth?: ConnectionHealth[];
  maxTunnelDevices?: number;
  groupSyncStatus?: GroupSyncStatus | null;
  groupMaxAckDeltaMs?: number;
  wifiReconnects?: Record<string, WifiReconnectStatus>;
}

const formatHealthClock = (unix?: number) => unix != null
  ? new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  : '';

const lastLocationSuccessAgeSeconds = (health: ConnectionHealth, now: number): number | null => {
  if (health.last_location_success_unix != null) {
    return Math.max(0, Math.floor(now / 1000 - health.last_location_success_unix));
  }
  if (health.last_location_success_age_seconds != null) {
    return Math.max(0, Math.floor(health.last_location_success_age_seconds));
  }
  return null;
};

const LocationHealthMeta: React.FC<{
  health?: ConnectionHealth;
  now: number;
  showEmpty?: boolean;
}> = ({ health, now, showEmpty = false }) => {
  const t = useT();
  if (!health) {
    return showEmpty ? (
      <div className="device-location-meta" style={{ fontSize: 9, opacity: 0.52, marginTop: 2 }}>
        {t('connection.location_last_success_none')}
      </div>
    ) : null;
  }
  const age = lastLocationSuccessAgeSeconds(health, now);
  const parts = age != null
    ? [t('connection.location_last_success_seconds', { n: age })]
    : [t('connection.location_last_success_none')];
  if (health.last_location_success_unix != null) {
    // Keep the relative age readable while exposing the real event time for
    // operators comparing two phones during strict group recovery.
    parts.push(formatHealthClock(health.last_location_success_unix));
  }
  if (health.last_location_recovery_unix != null) {
    parts.push(t('connection.location_recovered', { time: formatHealthClock(health.last_location_recovery_unix) }));
  }
  return (
    <div className="device-location-meta" style={{ fontSize: 9, opacity: 0.64, marginTop: 2, lineHeight: 1.35 }}>
      {parts.join(' · ')}
    </div>
  );
};

const DEVICE_PROGRESS_STEPS: DeviceProgressStep[] = ['exploring', 'tunnel', 'gps', 'recovery'];
const DEVICE_PROGRESS_GLYPHS: Record<DeviceProgressState, string> = {
  complete: '✓',
  active: '•',
  pending: '·',
  unverified: '?',
  blocked: '!',
  not_applicable: '—',
};
const DEVICE_PROGRESS_COLORS: Record<DeviceProgressState, string> = {
  complete: '#4ecdc4',
  active: '#ffb627',
  pending: 'rgba(255,255,255,0.46)',
  unverified: '#858b9a',
  blocked: '#ef7777',
  not_applicable: 'rgba(255,255,255,0.36)',
};

/** Compact, evidence-backed stage trail for one device in the group roster. */
const DeviceProgressStrip: React.FC<{
  stage: DeviceStage;
  transport: DeviceTransport;
}> = ({ stage, transport }) => {
  const t = useT();
  const progress = getDeviceProgress(stage, transport);
  const labelFor = (step: DeviceProgressStep, state: DeviceProgressState): string => {
    if (step === 'exploring') return t('group.device_exploring');
    if (step === 'tunnel') return t('group.device_tunnel');
    if (step === 'gps') return state === 'complete'
      ? t('group.device_gps_ready')
      : t('group.device_gps_waiting');
    return t('group.device_recovering');
  };

  return (
    <div
      className="device-progress-strip"
      aria-label={`device progress: ${stage}`}
      style={{ display: 'flex', alignItems: 'center', gap: 3, margin: '4px 0 1px 30px', minWidth: 0 }}
    >
      {DEVICE_PROGRESS_STEPS.map((step, index) => {
        const state = progress[step];
        const label = labelFor(step, state);
        return (
          <React.Fragment key={step}>
            {index > 0 && <span aria-hidden="true" style={{ color: 'rgba(255,255,255,0.28)', fontSize: 9 }}>›</span>}
            <span
              className={`device-progress-step progress-${state}`}
              title={`${label} · ${state}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 0,
                color: DEVICE_PROGRESS_COLORS[state], fontSize: 9, lineHeight: 1.25,
                opacity: state === 'unverified' || state === 'not_applicable' ? 0.78 : 1,
              }}
            >
              <span aria-hidden="true" style={{ fontWeight: 700 }}>{DEVICE_PROGRESS_GLYPHS[state]}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
};

const ConnectionHealthCard: React.FC<{ health: ConnectionHealth; isWifi?: boolean }> = ({ health, isWifi = false }) => {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const retrySeconds = health.retry_at_unix
    ? Math.max(0, Math.ceil(health.retry_at_unix - now / 1000))
    : Math.max(0, Math.ceil(health.retry_in_seconds ?? 0));
  const connectedButUnstable = health.state === 'connected'
    && (health.likely_hardware === true || health.usb_disconnects_5m >= 3);
  const locationRecovering = health.state === 'connected'
    && health.location_channel_state === 'recovering';
  const locationActive = health.state === 'connected'
    && health.location_active === true
    && health.location_channel_state === 'healthy';
  const formatDuration = (seconds: number) => {
    const value = Math.max(0, Math.floor(seconds));
    if (value < 60) return t('connection.health_duration_seconds', { n: value });
    const minutes = Math.floor(value / 60);
    if (minutes < 60) return t('connection.health_duration_minutes', { n: minutes });
    return t('connection.health_duration_hours', {
      h: Math.floor(minutes / 60),
      m: minutes % 60,
    });
  };
  const formatClock = (unix?: number) => unix
    ? new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '';
  const stableLabel = connectedButUnstable
    ? (isWifi ? t('connection.health_wifi_connected_unstable') : t('connection.health_connected_unstable'))
    : (isWifi ? t('connection.health_wifi_connected') : t('connection.health_connected'));
  const stableDetail = isWifi
    ? t('connection.health_wifi_connected_detail')
    : t('connection.health_connected_detail');
  const labels: Record<ConnectionHealth['state'], string> = {
    connected: stableLabel,
    stabilizing: t('connection.health_stabilizing', {
      current: health.stable_samples ?? 0,
      required: health.required_samples ?? 3,
    }),
    connecting: t('connection.health_connecting', { n: health.attempt ?? 1 }),
    reconnect_backoff: t('connection.health_backoff'),
    usb_absent: t('connection.health_absent'),
    usb_flapping: t('connection.usb_flapping', { n: health.usb_disconnects_5m }),
  };
  const label = locationRecovering
    ? t('connection.location_recovering')
    : locationActive
      ? t('connection.location_active')
      : labels[health.state];
  const details: string[] = [];
  if (health.state === 'connected') {
    const uptime = health.connected_since_unix
      ? now / 1000 - health.connected_since_unix
      : health.connection_uptime_seconds;
    if (uptime != null) {
      details.push(t('connection.health_uptime', { value: formatDuration(uptime) }));
    }
    if (locationRecovering) {
      details.push(t('connection.location_stalled', {
        value: formatDuration(health.location_stall_seconds ?? health.last_location_success_age_seconds ?? 0),
      }));
      details.push(t('connection.location_rebuilding'));
    } else if (locationActive) {
      details.push(stableDetail);
      // Exact last-success age and recovery time are rendered in the compact
      // metadata row below, shared by the active card and group roster.
    } else if (!connectedButUnstable) {
      // A transport connection alone does not prove that DVT accepted a GPS
      // write. Keep this card consistent with the per-device group roster.
      details.push(t('connection.location_pending_detail'));
    }
    if (connectedButUnstable && health.last_reconnect_unix) {
      details.push(t('connection.health_last_reconnect', { time: formatClock(health.last_reconnect_unix) }));
    }
    // Keep recovery time in LocationHealthMeta so all device cards use the
    // same presentation.
  }
  if (health.state === 'stabilizing') {
    const current = health.stable_samples ?? 0;
    const required = health.required_samples ?? 3;
    details.push(t('connection.health_stabilizing_detail', {
      current,
      remaining: Math.max(0, required - current),
    }));
  }
  if (health.state === 'connecting') {
    details.push(t('connection.health_connecting_detail'));
  }
  if (health.state === 'usb_absent') {
    details.push(t('connection.health_absent_detail'));
  }
  if (health.state === 'reconnect_backoff' && retrySeconds > 0) {
    details.push(t('connection.health_retry', { n: retrySeconds }));
  }
  if (health.usb_disconnects_5m > 0 && health.state !== 'usb_flapping') {
    details.push(t('connection.health_disconnects', { n: health.usb_disconnects_5m }));
  }
  if (health.state !== 'connected' && health.last_disconnect_unix) {
    details.push(t('connection.health_last_disconnect', { time: formatClock(health.last_disconnect_unix) }));
  }

  return (
    <div className={`connection-health-card state-${health.state}${connectedButUnstable ? ' is-unstable' : ''}${locationRecovering ? ' is-recovering' : ''}`}>
      <span className="connection-health-pulse" />
      <span style={{ minWidth: 0, flex: 1 }}>
        <strong>{label}</strong>
        {details.length > 0 && <small>{details.join(' · ')}</small>}
        {health.state === 'stabilizing' && (
          <span className="connection-health-progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, ((health.stable_samples ?? 0) / Math.max(1, health.required_samples ?? 3)) * 100)}%` }} />
          </span>
        )}
        <LocationHealthMeta health={health} now={now} showEmpty />
      </span>
    </div>
  );
};

const DeviceStatus: React.FC<DeviceStatusProps> = ({
  device,
  devices,
  isConnected,
  onScan,
  onSelect,
  onStartWifiTunnel,
  onStopTunnel,
  tunnelStatus = { running: false },
  tunnels = [],
  onWifiConnect,
  pinnedUdids = [],
  onTogglePin,
  connectionHealth = [],
  maxTunnelDevices = DEFAULT_MAX_TUNNEL_DEVICES,
  groupSyncStatus = null,
  groupMaxAckDeltaMs = 0,
  wifiReconnects = {},
}) => {
  const t = useT();
  const unverifiedLabel = t('diagnostics.not_verified');
  const [showDropdown, setShowDropdown] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [tunnelIp, setTunnelIp] = useState(() => localStorage.getItem('locwarp.tunnel.ip') || '');
  const [tunnelPort, setTunnelPort] = useState(() => localStorage.getItem('locwarp.tunnel.port') || '');
  const [portScanning, setPortScanning] = useState(false);
  const activeHealth = device
    ? connectionHealth.find((item) => item.udid.toLowerCase() === device.id.toLowerCase())
    : connectionHealth.find((item) => item.state === 'usb_flapping') ?? connectionHealth[0];
  const displayedHealth = reconcileConnectionHealth(
    activeHealth,
    isConnected && device && device.connectionType !== 'Network' ? device.id : null,
  ) ?? (!device ? {
    udid: 'no-usb-device',
    state: 'usb_absent' as const,
    usb_disconnects_5m: 0,
  } : undefined);
  // Saved IPs are written by useDevice.startWifiTunnel into
  // locwarp.tunnel.savedips as a max-5 ring buffer. Surface them here so
  // users can re-establish a tunnel to the same iPhone with one click,
  // instead of retyping the IP after every WiFi drop / manual Stop
  // (issue #29). Refresh whenever the dropdown is toggled or after a
  // successful connect so the list reflects useDevice's latest write.
  const readSavedIps = (): Array<{ ip: string; port: number; udid?: string; name?: string; model?: string; lastUsed: number }> => {
    try {
      const raw = localStorage.getItem('locwarp.tunnel.savedips') || '[]';
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e) => e && typeof e.ip === 'string' && typeof e.port === 'number');
    } catch { return []; }
  };
  const [savedIps, setSavedIps] = useState(readSavedIps);
  const [showSavedIps, setShowSavedIps] = useState(false);
  const refreshSavedIps = () => setSavedIps(readSavedIps());
  const removeSavedIp = (ip: string, port: number) => {
    const next = readSavedIps().filter((entry) => !(entry.ip === ip && entry.port === port));
    try { localStorage.setItem('locwarp.tunnel.savedips', JSON.stringify(next)); } catch { /* ignore */ }
    setSavedIps(next);
    if (next.length === 0) setShowSavedIps(false);
  };
  // Map udid -> last known device name, harvested from savedips. Lets the
  // active-tunnel card and recent list keep showing the real phone name
  // after a WiFi drop, instead of falling back to a raw UDID string
  // (issue #33). The name is written into savedips on every successful
  // connect by useDevice.startWifiTunnel.
  const savedNameByUdid: Record<string, string> = {};
  savedIps.forEach((e: any) => { if (e && e.udid && e.name) savedNameByUdid[canonicalUdid(e.udid)] = e.name; });
  const isPinnedUdid = (udid: string) => pinnedUdids.some((saved) => canonicalUdid(saved) === canonicalUdid(udid));
  // Auto-attempt the saved IP/port on app launch. Default ON so users who
  // previously connected over WiFi don't have to re-click on every cold
  // start — App.tsx reads this flag once after the WS handshake settles.
  const [autoConnectEnabled, setAutoConnectEnabled] = useState<boolean>(
    () => localStorage.getItem('locwarp.tunnel.autoconnect') !== '0',
  );
  const handleAutoConnectToggle = (next: boolean) => {
    setAutoConnectEnabled(next);
    try { localStorage.setItem('locwarp.tunnel.autoconnect', next ? '1' : '0'); } catch { /* ignore */ }
  };
  // Keep-alive lives on the backend (it pokes the RSD tunnel), so we read
  // its current value once on mount and write changes through the API.
  const [keepaliveEnabled, setKeepaliveEnabled] = useState<boolean>(true);
  React.useEffect(() => {
    wifiKeepaliveGet().then((r) => setKeepaliveEnabled(r.enabled !== false)).catch(() => { /* keep default */ });
  }, []);
  const handleKeepaliveToggle = (next: boolean) => {
    setKeepaliveEnabled(next);
    wifiKeepaliveSet(next).catch(() => { /* best-effort */ });
  };
  const [tunnelConnecting, setTunnelConnecting] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [showIpHelp, setShowIpHelp] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [wifiExpanded, setWifiExpanded] = useState(false);
  const [showWifiWarning, setShowWifiWarning] = useState(false);
  const [showRepairConfirm, setShowRepairConfirm] = useState(false);
  const [repairState, setRepairState] = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const [repairMessage, setRepairMessage] = useState<string>('');
  const [ddiMountState, setDdiMountState] = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const [ddiMountMessage, setDdiMountMessage] = useState<string>('');
  const tunnelLimit = Math.min(
    PRODUCT_MAX_TUNNEL_DEVICES,
    Math.max(1, Math.floor(Number(maxTunnelDevices) || DEFAULT_MAX_TUNNEL_DEVICES)),
  );

  // Keep the connection page useful in group mode: a single selected-device
  // health card is not enough to explain why 1/2 or 2/2 phones can receive a
  // GPS update. This compact roster surfaces paired/connected/tunnel/GPS
  // state for every known device without changing any backend semantics.
  //
  // A recovery event can arrive before listDevices() rediscovers the missing
  // phone. Include the backend's real group member/missing UDIDs as read-only
  // placeholders so the summary still says which member is absent. A
  // placeholder never supplies health, transport, IP, or GPS evidence.
  const syncMembers = groupSyncStatus?.members ?? [];
  const syncMemberByUdid = new Map(
    syncMembers
      .filter((member) => member && typeof member.udid === 'string')
      .map((member) => [canonicalUdid(member.udid), member]),
  );
  const groupDeviceList = devices.slice(0, PRODUCT_MAX_TUNNEL_DEVICES);
  const groupDeviceKeys = new Set(groupDeviceList.map((item) => canonicalUdid(item.id)));
  const syncRosterUdids = [
    ...syncMembers.map((member) => member.udid),
    ...(groupSyncStatus?.missing_udids ?? []),
    ...(groupSyncStatus?.lost_udids ?? []),
  ];
  for (const udid of syncRosterUdids) {
    const key = canonicalUdid(udid);
    if (!key || groupDeviceKeys.has(key) || groupDeviceList.length >= PRODUCT_MAX_TUNNEL_DEVICES) continue;
    const member = syncMemberByUdid.get(key);
    const suffix = formatUdidSuffix(udid);
    groupDeviceList.push({
      id: udid,
      name: suffix ? `UDID ···${suffix}` : 'UDID',
      iosVersion: '',
      connectionType: undefined,
      isConnected: member?.connected === true,
    });
    groupDeviceKeys.add(key);
  }
  const groupDevices = groupDeviceList;
  const tunnelByUdid = new Map(tunnels.map((tn) => [canonicalUdid(tn.udid), tn]));
  const healthByUdid = new Map(connectionHealth.map((health) => [canonicalUdid(health.udid), health]));
  const healthFor = (item: Device) => healthByUdid.get(canonicalUdid(item.id));
  const tunnelFor = (item: Device) => tunnelByUdid.get(canonicalUdid(item.id));
  const reconnectFor = (item: Device) => wifiReconnects[canonicalUdid(item.id)];
  const savedWifiIpFor = (item: Device): string | null => {
    const key = canonicalUdid(item.id);
    const entry = savedIps.find((candidate) => candidate.udid && canonicalUdid(candidate.udid) === key);
    return entry?.ip || null;
  };
  const transportFor = (item: Device): DeviceTransport => getDeviceTransport(
    item.connectionType,
    Boolean(tunnelFor(item)),
  );
  const wifiIpFor = (item: Device): string | null => {
    const reconnectIp = reconnectFor(item)?.ip?.trim();
    return reconnectIp || savedWifiIpFor(item);
  };
  const isDeviceConnected = (item: Device) => {
    const health = healthFor(item);
    return item.isConnected === true
      || canonicalUdid(item.id) === canonicalUdid(device?.id) && isConnected
      || tunnelByUdid.has(canonicalUdid(item.id))
      || health?.is_connected === true
      || health?.location_channel_state === 'healthy'
      || health?.location_channel_state === 'recovering';
  };
  const connectionStage = (item: Device): DeviceStage => getDeviceStage({
    isConnected: isDeviceConnected(item),
    connectionType: item.connectionType,
    hasTunnel: tunnelByUdid.has(canonicalUdid(item.id)),
    health: healthFor(item),
  });
  const isGroupMissing = (item: Device) => {
    const key = canonicalUdid(item.id);
    const member = syncMemberByUdid.get(key);
    return (groupSyncStatus?.missing_udids ?? []).some((udid) => canonicalUdid(udid) === key)
      || (groupSyncStatus?.lost_udids ?? []).some((udid) => canonicalUdid(udid) === key)
      || member?.lost === true;
  };
  const isGroupDegraded = (item: Device) => {
    const key = canonicalUdid(item.id);
    const member = syncMemberByUdid.get(key);
    return (groupSyncStatus?.degraded_udids ?? []).some((udid) => canonicalUdid(udid) === key)
      || member?.degraded === true;
  };
  const displayStage = (item: Device): DeviceStage => {
    if (isGroupMissing(item)) return 'offline';
    // `degraded` is emitted by the strict-sync coordinator when a member is
    // not safe to receive the next GPS update. It is a real recovery signal,
    // but it must not count as GPS-ready without a healthy location event.
    if (isGroupDegraded(item)) return 'recovering';
    return connectionStage(item);
  };
  const isDeviceReady = (item: Device) => connectionStage(item) === 'gps' && !isGroupMissing(item) && !isGroupDegraded(item);
  const stageLabel = (stage: DeviceStage) => ({
    paired: t('group.device_paired'),
    exploring: t('group.device_exploring'),
    tunnel: t('group.device_tunnel'),
    gps: t('group.device_gps_ready'),
    gps_waiting: t('group.device_gps_waiting'),
    recovering: t('group.device_recovering'),
    offline: t('group.device_offline'),
    // Kept for forward compatibility with older snapshots that may still
    // pass a generic connected stage into this presentation map.
    connected: t('group.device_connected'),
  }[stage] || stage);
  const reconnectLabel = (status?: WifiReconnectStatus) => {
    if (!status || status.stage === 'idle' || status.stage === 'connected') return null;
    if (status.stage === 'last_ip') return t('wifi.reconnect_last_ip');
    if (status.stage === 'network_changed_discovery') return t('wifi.reconnect_network_changed');
    if (status.stage === 'found_name') return t('wifi.reconnect_found', { name: status.name || status.udid.slice(-8) });
    if (status.stage === 'tunnel') return t('wifi.reconnect_tunnel');
    if (status.stage === 'needs_usb_repair') return t('wifi.reconnect_needs_usb');
    if (status.stage === 'failed') return t('wifi.reconnect_retrying');
    return null;
  };
  const readyCount = countGpsReady(groupDevices, displayStage);

  const groupTotal = Math.max(
    groupDevices.length,
    Number(groupSyncStatus?.expected_count) > 0 ? Number(groupSyncStatus?.expected_count) : 0,
  );
  const syncMaxFromStatus = Number(groupSyncStatus?.max_ack_delta_ms);
  const syncLastFromStatus = Number(groupSyncStatus?.last_ack_delta_ms);
  const syncDeltaMs = groupMaxAckDeltaMs > 0
    ? groupMaxAckDeltaMs
    : Number.isFinite(syncMaxFromStatus) && syncMaxFromStatus >= 0
      ? syncMaxFromStatus
      : Number.isFinite(syncLastFromStatus) && syncLastFromStatus >= 0
        ? syncLastFromStatus
        : null;
  const syncDeltaKnown = syncDeltaMs != null;
  const syncMissingUdids = Array.from(new Set([
    ...(groupSyncStatus?.missing_udids ?? []),
    ...(groupSyncStatus?.lost_udids ?? []),
  ].map(canonicalUdid).filter(Boolean)));
  const syncMissingLabels = syncMissingUdids.map((udid) => {
    const known = groupDevices.find((item) => canonicalUdid(item.id) === udid);
    return known?.name || `UDID ···${formatUdidSuffix(udid)}`;
  });
  const unidentifiedMissingCount = Math.max(0, groupTotal - groupDevices.length - syncMissingLabels.length);

  const handleRepair = async () => {
    setRepairState('running');
    setRepairMessage('');
    try {
      const res = await wifiRepair();
      setRepairState('success');
      setRepairMessage(`${res.name || 'iPhone'} (iOS ${res.ios_version})`);
    } catch (err: any) {
      setRepairState('failed');
      setRepairMessage(err?.message || 'Unknown error');
    }
  };
  const handleDdiMount = async (udid: string) => {
    setDdiMountState('running');
    setDdiMountMessage('');
    try {
      const res = await mountPersonalizedDdi(udid);
      setDdiMountState('success');
      setDdiMountMessage(res?.message || t('ddi.mount_success'));
    } catch (err: any) {
      setDdiMountState('failed');
      setDdiMountMessage(err?.message || t('ddi.mount_failed'));
    }
  };
  const [scanning, setScanning] = useState(false);
  // null = no recent scan; number = device count from most recent scan (flash display)
  const [scanResult, setScanResult] = useState<number | null>(null);
  const scanResultTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const devicesRef = React.useRef(devices);
  devicesRef.current = devices;

  const handleScan = async () => {
    if (scanResultTimer.current) clearTimeout(scanResultTimer.current);
    setScanning(true);
    setScanResult(null);
    try {
      await Promise.resolve(onScan());
    } finally {
      setScanning(false);
      // Read the freshest devices state via ref — parent has updated by now
      setScanResult(devicesRef.current.length);
      scanResultTimer.current = setTimeout(() => setScanResult(null), 2000);
    }
  };

  React.useEffect(() => () => {
    if (scanResultTimer.current) clearTimeout(scanResultTimer.current);
  }, []);
  // WiFi tunnel remains iOS 17+ only; iOS 16 devices are supported over USB.

  // Multi-result detect: keep the full list and let the user pick one when
  // mDNS / subnet scan returns 2+ iPhones. Single result auto-fills as before.
  const [discoverResults, setDiscoverResults] = useState<DiscoveryEndpoint[]>([]);
  const handleDiscover = async () => {
    setDiscovering(true);
    setTunnelError(null);
    setDiscoverResults([]);
    try {
      const res = await wifiTunnelDiscover();
      const rawList = (res?.devices || []) as DiscoveryEndpoint[];
      // Bonjour reports both the normal LAN endpoint and a USB/NCM
      // 169.254.x.x endpoint for one phone. Keep the normal endpoint in the
      // picker so users do not accidentally select the transport detail.
      const list = collapseLinkLocalDiscovery(rawList);
      if (list.length === 0) {
        setTunnelError(t('wifi.device_not_detected'));
      } else if (list.length === 1) {
        setTunnelIp(list[0].ip);
        setTunnelPort(String(list[0].port));
      } else {
        setDiscoverResults(list);
      }
    } catch (err: any) {
      setTunnelError(err.message || t('wifi.detect_failed'));
    } finally {
      setDiscovering(false);
    }
  };
  const pickDiscoverResult = (r: DiscoveryEndpoint) => {
    setTunnelIp(r.ip);
    setTunnelPort(String(r.port));
    setDiscoverResults([]);
  };
  const discoveryDetails = (r: DiscoveryEndpoint) => {
    return resolveDiscoveryIdentity(r, savedIps, devices);
  };

  return (
    <div className={`device-status ${isConnected ? 'device-connected' : 'device-disconnected'}`}>
      {displayedHealth && <ConnectionHealthCard health={displayedHealth} isWifi={device?.connectionType === 'Network'} />}
      {(groupDevices.length > 1 || groupTotal > 1) && (
        <div
          className="connection-group-summary"
          aria-label={t('group.connection_summary', { ready: readyCount, total: groupTotal })}
          style={{
            marginBottom: 8, padding: '7px 9px', borderRadius: 6,
            border: '1px solid rgba(108, 140, 255, 0.22)',
            background: 'rgba(108, 140, 255, 0.07)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
            <strong style={{ fontSize: 11 }}>{t('group.connection_summary', { ready: readyCount, total: groupTotal })}</strong>
            <span style={{ fontSize: 10, opacity: 0.6 }}>{tunnelLimit} max</span>
          </div>
          {groupSyncStatus && ['paused', 'recovering', 'recovery_failed'].includes(groupSyncStatus.status) && (
            <div
              className="group-sync-recovery"
              style={{ marginBottom: 5, fontSize: 10, color: groupSyncStatus.status === 'recovery_failed' ? '#ef7777' : '#ffb627' }}
            >
              {t('group.reconnecting', {
                ready: groupSyncStatus.ready_count ?? readyCount,
                total: groupSyncStatus.expected_count ?? groupSyncStatus.total ?? groupTotal,
                attempt: groupSyncStatus.attempt ?? 1,
                max: groupSyncStatus.max_attempts ?? 3,
              })}
            </div>
          )}
          {syncMissingLabels.length > 0 && (
            <div className="group-sync-missing" style={{ marginBottom: 5, fontSize: 10, color: '#ef7777' }}>
              {t('group.device_offline')}: {syncMissingLabels.join(', ')}
            </div>
          )}
          {unidentifiedMissingCount > 0 && (
            <div className="group-sync-missing-unverified" style={{ marginBottom: 5, fontSize: 10, color: '#858b9a' }}>
              {t('group.device_offline')}: {unverifiedLabel} ({unidentifiedMissingCount})
            </div>
          )}
          {(groupSyncStatus || groupMaxAckDeltaMs > 0) && (
            <div className="group-sync-skew" style={{ marginBottom: 5, fontSize: 9, opacity: 0.64 }}>
              {t('group.max_sync_delta', { ms: syncDeltaKnown ? Math.round(syncDeltaMs as number) : unverifiedLabel })}
            </div>
          )}
          <div style={{ display: 'grid', gap: 3 }}>
            {groupDevices.map((item, index) => {
              const stage = displayStage(item);
              const ready = isDeviceReady(item);
              const health = healthFor(item);
              const reconnect = reconnectFor(item);
              const reconnectText = reconnectLabel(reconnect);
              const transport = transportFor(item);
              const transportLabel = transport === 'usb'
                ? 'USB'
                : transport === 'wifi'
                  ? 'Wi-Fi'
                  : unverifiedLabel;
              const wifiIp = wifiIpFor(item);
              const tunnel = tunnelFor(item);
              const stageColor = stage === 'gps'
                ? '#4ecdc4'
                : stage === 'offline'
                  ? '#ef7777'
                  : isDeviceConnected(item)
                    ? '#ffb627'
                    : '#858b9a';
              return (
                <div key={item.id} className={`device-group-member device-stage-${stage}`} style={{ minWidth: 0, fontSize: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: stageColor }} />
                    <span style={{ color: ['#4285f4', '#ff9800', '#9c6ade'][index] || '#9aa4bd', fontWeight: 700, flexShrink: 0 }}>{String.fromCharCode(65 + index)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.name || item.id.slice(0, 10)}</span>
                    <span style={{ opacity: ready ? 0.95 : 0.72, whiteSpace: 'nowrap', color: ready ? '#4ecdc4' : undefined }}>{stageLabel(stage)}</span>
                  </div>
                  <div
                    className="device-connection-meta"
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginLeft: 30, marginTop: 2, fontSize: 9, opacity: 0.64, lineHeight: 1.35 }}
                  >
                    <span>{transportLabel}</span>
                    <span title={wifiIp ? undefined : `IP ${unverifiedLabel}`}>IP {wifiIp || unverifiedLabel}</span>
                    {tunnel?.rsd_address && tunnel?.rsd_port != null && (
                      <span style={{ fontFamily: 'monospace' }}>RSD {tunnel.rsd_address}:{tunnel.rsd_port}</span>
                    )}
                  </div>
                  <DeviceProgressStrip stage={stage} transport={transport} />
                  {reconnectText && (
                    <div
                      className={`device-reconnect-stage reconnect-${reconnect?.stage}`}
                      style={{
                        marginLeft: 30,
                        marginTop: 2,
                        fontSize: 9,
                        lineHeight: 1.35,
                        color: reconnect?.stage === 'needs_usb_repair' ? '#ef7777' : '#ffb627',
                      }}
                    >
                      {reconnectText}{(reconnect?.attempt ?? 0) > 1 ? ` · ${t('wifi.reconnect_attempt', { n: reconnect?.attempt ?? 1 })}` : ''}
                    </div>
                  )}
                  {reconnect?.error && (reconnect.stage === 'failed' || reconnect.stage === 'needs_usb_repair') && (
                    <div style={{ marginLeft: 30, marginTop: 2, fontSize: 9, color: '#ef7777', overflowWrap: 'anywhere' }}>
                      {reconnect.error}
                    </div>
                  )}
                  <LocationHealthMeta health={health} now={now} showEmpty />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Device info card — no scan button inside */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <div
          style={{
            width: 10, height: 10, borderRadius: '50%', flexShrink: 0, marginTop: 4,
            background: isConnected ? '#4caf50' : '#f44336',
            boxShadow: isConnected ? '0 0 6px #4caf50' : '0 0 6px #f44336',
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {device ? (() => {
            const isWifi = device.connectionType === 'Network';
            const iosMajor = Number.parseInt(String(device.iosVersion || '0').split('.')[0] || '0', 10);
            const showDdiRepair = !isWifi && Number.isFinite(iosMajor) && iosMajor >= 17;
            const activeTunnel = isWifi ? tunnelFor(device) : null;
            const knownWifiIp = isWifi ? wifiIpFor(device) : null;
            const pinned = activeTunnel ? isPinnedUdid(device.id) : false;
            return (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                  {device.name}
                </div>
                <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 3 }}>
                  <span>iOS {device.iosVersion}</span>
                  <span style={{
                    padding: '1px 6px', borderRadius: 3, fontSize: 11,
                    background: isWifi ? 'rgba(76, 175, 80, 0.15)' : 'rgba(108, 140, 255, 0.15)',
                    color: isWifi ? '#4caf50' : '#6c8cff',
                  }}>
                  {isWifi ? 'WiFi' : 'USB'}
                  </span>
                  {isWifi && (
                    <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: knownWifiIp ? 0.75 : 0.58 }} title={knownWifiIp ? undefined : `IP ${unverifiedLabel}`}>
                      IP {knownWifiIp || unverifiedLabel}
                    </span>
                  )}
                  {activeTunnel && (
                    <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.75 }}>
                      {activeTunnel.rsd_address}:{activeTunnel.rsd_port}
                    </span>
                  )}
                </div>
                {groupDevices.length <= 1 && (
                  <DeviceProgressStrip stage={displayStage(device)} transport={transportFor(device)} />
                )}
                {activeTunnel && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                    {onTogglePin && (
                      <button
                        onClick={() => onTogglePin(device.id)}
                        title={pinned ? t('wifi.pin_on_tooltip') : t('wifi.pin_off_tooltip')}
                        style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                          border: pinned ? '1px solid rgba(108, 140, 255, 0.6)' : '1px solid rgba(255,255,255,0.18)',
                          background: pinned ? 'rgba(108, 140, 255, 0.18)' : 'transparent',
                          color: pinned ? '#9ac0ff' : 'var(--text-muted)',
                        }}
                      >
                        {pinned ? t('wifi.pin_on') : t('wifi.pin_off')}
                      </button>
                    )}
                    <button
                      onClick={async () => { if (onStopTunnel) await onStopTunnel(device.id); }}
                      style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                        border: '1px solid rgba(244, 67, 54, 0.45)',
                        background: 'rgba(244, 67, 54, 0.08)', color: '#f44336',
                      }}
                    >
                      {t('wifi.tunnel_stop')}
                    </button>
                  </div>
                )}
                {showDdiRepair && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                    <button
                      onClick={() => { if (ddiMountState !== 'running') void handleDdiMount(device.id); }}
                      disabled={ddiMountState === 'running'}
                      title={t('ddi.mount_tooltip')}
                      style={{
                        fontSize: 11,
                        padding: '3px 10px',
                        borderRadius: 4,
                        cursor: ddiMountState === 'running' ? 'default' : 'pointer',
                        border: '1px solid rgba(108, 140, 255, 0.45)',
                        background: 'rgba(108, 140, 255, 0.12)',
                        color: '#9ac0ff',
                        opacity: ddiMountState === 'running' ? 0.7 : 1,
                      }}
                    >
                      {ddiMountState === 'running' ? t('ddi.mount_running') : t('ddi.mount_button')}
                    </button>
                    {ddiMountMessage && (
                      <span
                        style={{
                          fontSize: 11,
                          color: ddiMountState === 'failed' ? '#ff8a80' : 'var(--text-muted)',
                          opacity: 0.9,
                        }}
                      >
                        {ddiMountMessage}
                      </span>
                    )}
                  </div>
                )}
              </>
            );
          })() : (
            <div style={{ fontSize: 13, opacity: 0.55 }}>No device</div>
          )}
        </div>
      </div>

      {/* USB scan button — standalone row below device info */}
      <button
        className="action-btn"
        onClick={handleScan}
        disabled={scanning}
        style={{ width: '100%', padding: '6px 10px', fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        title={t('device.scan_tooltip')}
      >
        {scanning ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="16" />
            </svg>
            {t('device.scan_scanning')}
          </>
        ) : scanResult != null && scanResult > 0 ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span style={{ color: '#4caf50' }}>{t('device.scan_found', { n: scanResult })}</span>
          </>
        ) : scanResult === 0 ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f44336" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span style={{ color: '#f44336' }}>{t('device.scan_none')}</span>
          </>
        ) : (
          t('device.scan_tooltip')
        )}
      </button>

      {/* WiFi tunnel cards for additional devices not shown in the top row */}
      {tunnels.filter((tn) => canonicalUdid(tn.udid) !== canonicalUdid(device?.id)).length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {tunnels.filter((tn) => canonicalUdid(tn.udid) !== canonicalUdid(device?.id)).map((tn) => {
            const dev = devices.find((d) => canonicalUdid(d.id) === canonicalUdid(tn.udid));
            const dispName = dev?.name || savedNameByUdid[canonicalUdid(tn.udid)] || tn.udid.slice(0, 12);
            const knownIp = wifiReconnects[canonicalUdid(tn.udid)]?.ip
              || savedIps.find((entry) => entry.udid && canonicalUdid(entry.udid) === canonicalUdid(tn.udid))?.ip
              || null;
            const pinned = isPinnedUdid(tn.udid);
            return (
              <div key={tn.udid} style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                marginBottom: 4, padding: '5px 8px',
                background: 'rgba(76, 175, 80, 0.08)',
                border: '1px solid rgba(76, 175, 80, 0.25)',
                borderRadius: 3,
              }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4caf50', flexShrink: 0, boxShadow: '0 0 4px #4caf50', marginTop: 3 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35 }}>
                    {dispName}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
                    {dev?.iosVersion && <span>iOS {dev.iosVersion}</span>}
                    <span style={{ padding: '1px 6px', borderRadius: 3, background: 'rgba(76, 175, 80, 0.15)', color: '#4caf50', fontSize: 11 }}>WiFi</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: knownIp ? 0.75 : 0.58 }} title={knownIp ? undefined : `IP ${unverifiedLabel}`}>IP {knownIp || unverifiedLabel}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.75 }}>{tn.rsd_address}:{tn.rsd_port}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                    {onTogglePin && (
                      <button
                        onClick={() => onTogglePin(tn.udid)}
                        title={pinned ? t('wifi.pin_on_tooltip') : t('wifi.pin_off_tooltip')}
                        style={{
                          fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                          border: pinned ? '1px solid rgba(108, 140, 255, 0.6)' : '1px solid rgba(255,255,255,0.18)',
                          background: pinned ? 'rgba(108, 140, 255, 0.18)' : 'transparent',
                          color: pinned ? '#9ac0ff' : 'var(--text-muted)',
                        }}
                      >
                        {pinned ? t('wifi.pin_on') : t('wifi.pin_off')}
                      </button>
                    )}
                    <button
                      onClick={async () => { if (onStopTunnel) await onStopTunnel(tn.udid); }}
                      style={{
                        fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                        border: '1px solid rgba(244, 67, 54, 0.45)',
                        background: 'rgba(244, 67, 54, 0.08)', color: '#f44336',
                      }}
                    >
                      {t('wifi.tunnel_stop')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Device dropdown — only shown when 2+ USB devices found; single device auto-connects */}
      {devices.length > 1 && (
        <div style={{ position: 'relative', marginBottom: 6 }}>
          <button
            className="action-btn"
            onClick={() => setShowDropdown(!showDropdown)}
            style={{ width: '100%', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <rect x="5" y="2" width="14" height="20" rx="2" />
                <line x1="12" y1="18" x2="12" y2="18" />
              </svg>
              {t('device.scan_found', { n: devices.length })}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ transform: showDropdown ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
            >
              <polyline points="6,9 12,15 18,9" />
            </svg>
          </button>

          {showDropdown && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                background: '#2a2a2e',
                border: '1px solid #444',
                borderRadius: 4,
                marginTop: 4,
                zIndex: 100,
                boxShadow: '0 4px 8px rgba(0,0,0,0.3)',
              }}
            >
              {devices.map((d) => {
                // iOS 16 is supported again. Keep only truly older devices
                // disabled so users don't waste a click waiting for the
                // backend to reject the connect.
                const major = parseInt((d.iosVersion || '0').split('.')[0], 10) || 0;
                const unsupported = major > 0 && major < 16;
                return (
                <div
                  key={d.id}
                  onClick={() => {
                    if (unsupported) return;
                    onSelect(d.id);
                    setShowDropdown(false);
                  }}
                  style={{
                    padding: '8px 12px',
                    cursor: unsupported ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderBottom: '1px solid #333',
                    background: device?.id === d.id ? '#3a3a4e' : 'transparent',
                    opacity: unsupported ? 0.55 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (unsupported) return;
                    (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
                  }}
                  onMouseLeave={(e) => {
                    if (unsupported) return;
                    (e.currentTarget as HTMLDivElement).style.background = device?.id === d.id ? '#3a3a4e' : 'transparent';
                  }}
                  title={unsupported ? t('device.ios_unsupported_label', { version: d.iosVersion }) : undefined}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={unsupported ? '#f44336' : 'currentColor'} strokeWidth="2">
                    {unsupported ? (
                      <>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </>
                    ) : (
                      <>
                        <rect x="5" y="2" width="14" height="20" rx="2" />
                        <line x1="12" y1="18" x2="12" y2="18" />
                      </>
                    )}
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: device?.id === d.id ? 600 : 400 }}>{d.name}</div>
                    <div style={{ opacity: 0.5, fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {unsupported
                        ? <span style={{ color: '#f44336' }}>{t('device.ios_unsupported_label', { version: d.iosVersion })}</span>
                        : <>iOS {d.iosVersion}</>}
                      {d.connectionType && !unsupported && (
                        <span style={{
                          fontSize: 9,
                          padding: '0 3px',
                          borderRadius: 2,
                          background: d.connectionType === 'Network' ? 'rgba(76, 175, 80, 0.15)' : 'rgba(108, 140, 255, 0.15)',
                          color: d.connectionType === 'Network' ? '#4caf50' : '#6c8cff',
                        }}>
                          {d.connectionType === 'Network' ? 'WiFi' : 'USB'}
                        </span>
                      )}
                    </div>
                  </div>
                  {device?.id === d.id && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="3" style={{ marginLeft: 'auto' }}>
                      <polyline points="20,6 9,17 4,12" />
                    </svg>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* WiFi Connection Section — collapsible with iOS version tabs */}
      {(onStartWifiTunnel || onWifiConnect) && (
        <div style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 4 }}>
          {/* Collapsible header */}
          <button
            onClick={() => setWifiExpanded(!wifiExpanded)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', background: 'transparent',
              border: 'none', color: 'inherit', padding: 0, cursor: 'pointer',
              fontSize: 12,
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>{t('wifi.section_title')}</span>
              <span
                role="button"
                aria-label={t('wifi.warning_label')}
                title={t('wifi.warning_label')}
                onClick={(e) => { e.stopPropagation(); setShowWifiWarning(true); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, borderRadius: '50%',
                  background: 'rgba(255, 193, 7, 0.15)', color: '#ffc107',
                  fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  border: '1px solid rgba(255, 193, 7, 0.4)',
                }}
              >!</span>
            </span>
            <svg
              width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ transform: wifiExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', opacity: 0.6 }}
            >
              <polyline points="6,9 12,15 18,9" />
            </svg>
          </button>

          {wifiExpanded && (
            <div style={{ marginTop: 8 }}>
              {/* Help + Discover + Repair buttons row */}
              <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
                <button
                  onClick={() => setShowIpHelp(!showIpHelp)}
                  style={{
                    flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 5,
                    border: `1px solid ${showIpHelp ? 'rgba(108,140,255,0.5)' : 'rgba(255,255,255,0.18)'}`,
                    background: showIpHelp ? 'rgba(108,140,255,0.12)' : 'rgba(255,255,255,0.05)',
                    color: showIpHelp ? '#9ac0ff' : 'rgba(255,255,255,0.75)',
                    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  {t('wifi.help_ip')}
                </button>
                <button
                  onClick={handleDiscover}
                  disabled={discovering || tunnels.length >= tunnelLimit}
                  title={t('wifi.detect_tooltip')}
                  style={{
                    flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 5,
                    border: '1px solid rgba(108, 140, 255, 0.5)',
                    background: 'rgba(108, 140, 255, 0.12)',
                    color: '#6c8cff', cursor: discovering ? 'wait' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    opacity: (discovering || tunnels.length >= tunnelLimit) ? 0.5 : 1,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={discovering ? { animation: 'spin 1s linear infinite' } : undefined}>
                    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  {discovering ? t('wifi.detect_scanning') : t('wifi.detect')}
                </button>
                <button
                  onClick={() => { setRepairState('idle'); setRepairMessage(''); setShowRepairConfirm(true); }}
                  title={t('wifi.repair_tooltip')}
                  style={{
                    flex: 1, fontSize: 11, padding: '5px 0', borderRadius: 5,
                    background: 'rgba(255, 193, 7, 0.08)',
                    border: '1px solid rgba(255, 193, 7, 0.35)',
                    color: '#ffc107', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 12a9 9 0 11-6.219-8.56" /><polyline points="21 3 21 9 15 9" />
                  </svg>
                  {t('wifi.repair_button')}
                </button>
              </div>

              {showIpHelp && (
                <div style={{
                  fontSize: 11, padding: '8px 10px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.08)',
                  border: '1px solid rgba(108, 140, 255, 0.3)',
                  borderRadius: 4, lineHeight: 1.6,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#6c8cff' }}>
                    {t('wifi.help_title')}
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    {t('wifi.help_steps')}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 6 }}>
                    {t('wifi.help_hint')}
                  </div>
                </div>
              )}

              {/* Multi-result discovery picker — appears when /detect returns 2+ iPhones */}
              {discoverResults.length > 0 && (
                <div style={{
                  fontSize: 11, padding: '6px 8px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.06)',
                  border: '1px solid rgba(108, 140, 255, 0.3)',
                  borderRadius: 4,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#6c8cff' }}>
                    {t('wifi.tunnel_detect_multiple', { n: discoverResults.length })}
                  </div>
                  {discoverResults.map((r) => (
                    <div key={`${r.ip}:${r.port}`} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 0', borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}>
                      {(() => {
                        const details = discoveryDetails(r);
                        return (
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                              {details.name}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2, fontSize: 10, opacity: 0.62 }}>
                              <span>{details.model || t('wifi.discovery_model_unknown')}</span>
                              <span>{details.suffix ? `UDID ···${details.suffix}` : t('wifi.discovery_udid_unknown')}</span>
                              <span style={{ fontFamily: 'monospace' }}>{r.ip}:{r.port}</span>
                            </div>
                          </div>
                        );
                      })()}
                      <button
                        onClick={() => pickDiscoverResult(r)}
                        style={{
                          fontSize: 10, padding: '2px 6px', borderRadius: 3,
                          border: '1px solid rgba(108, 140, 255, 0.5)',
                          background: 'rgba(108, 140, 255, 0.12)', color: '#6c8cff',
                          cursor: 'pointer',
                        }}
                      >
                        {t('wifi.tunnel_use_this')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Auto-connect on launch toggle */}
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 11, padding: '5px 8px', marginBottom: 6,
                  background: 'rgba(108, 140, 255, 0.06)',
                  border: '1px solid rgba(108, 140, 255, 0.2)',
                  borderRadius: 4, cursor: 'pointer',
                }}
                title={t('wifi.autoconnect_tooltip')}
              >
                <input type="checkbox" checked={autoConnectEnabled} onChange={(e) => handleAutoConnectToggle(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: 'relative', display: 'inline-flex', alignItems: 'center',
                  width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                  background: autoConnectEnabled ? '#6c8cff' : 'rgba(255,255,255,0.18)',
                  transition: 'background 0.2s',
                }}>
                  <span style={{
                    position: 'absolute', left: autoConnectEnabled ? 14 : 1,
                    top: '50%', transform: 'translateY(-50%)',
                    width: 13, height: 13, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.18s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                  }} />
                </span>
                <span style={{ flex: 1 }}>{t('wifi.autoconnect_label')}</span>
              </label>

              {/* Keep-alive toggle */}
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 11, padding: '5px 8px', marginBottom: 8,
                  background: 'rgba(108, 140, 255, 0.06)',
                  border: '1px solid rgba(108, 140, 255, 0.2)',
                  borderRadius: 4, cursor: 'pointer',
                }}
                title={t('wifi.keepalive_tooltip')}
              >
                <input type="checkbox" checked={keepaliveEnabled} onChange={(e) => handleKeepaliveToggle(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: 'relative', display: 'inline-flex', alignItems: 'center',
                  width: 28, height: 15, borderRadius: 8, flexShrink: 0,
                  background: keepaliveEnabled ? '#6c8cff' : 'rgba(255,255,255,0.18)',
                  transition: 'background 0.2s',
                }}>
                  <span style={{
                    position: 'absolute', left: keepaliveEnabled ? 14 : 1,
                    top: '50%', transform: 'translateY(-50%)',
                    width: 13, height: 13, borderRadius: '50%',
                    background: '#fff', transition: 'left 0.18s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                  }} />
                </span>
                <span style={{ flex: 1 }}>{t('wifi.keepalive_label')}</span>
              </label>

              {/* iOS 17+ WiFi Tunnel (RSD) — add form */}
              {onStartWifiTunnel && (
                <>
                  {tunnels.length >= tunnelLimit ? (
                    <div style={{
                      fontSize: 11, padding: '6px 8px', textAlign: 'center',
                      opacity: 0.5,
                      border: '1px dashed rgba(255,255,255,0.15)',
                      borderRadius: 3,
                    }}>
                      {t('wifi.tunnel_max_reached', { max: tunnelLimit })}
                    </div>
                  ) : (
                    <div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 4, position: 'relative' }}>
                        <span style={{ opacity: 0.7, width: 36 }}>IP</span>
                        <input
                          type="text" className="search-input"
                          placeholder={t('wifi.ip_placeholder')}
                          value={tunnelIp} onChange={(e) => setTunnelIp(e.target.value)}
                          style={{ flex: 1, fontSize: 12, paddingLeft: 10 }} disabled={tunnelConnecting}
                        />
                        {savedIps.length > 0 && (
                          <button
                            type="button"
                            onClick={() => { refreshSavedIps(); setShowSavedIps((v) => !v); }}
                            disabled={tunnelConnecting}
                            title={t('wifi.recent_ips_tooltip')}
                            style={{
                              padding: '2px 6px', fontSize: 10, lineHeight: 1.2,
                              background: 'rgba(108, 140, 255, 0.12)',
                              border: '1px solid rgba(108, 140, 255, 0.35)',
                              color: '#9ac0ff', borderRadius: 3,
                              cursor: tunnelConnecting ? 'not-allowed' : 'pointer',
                              display: 'inline-flex', alignItems: 'center', gap: 3,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('wifi.recent_ips_button', { n: savedIps.length })}
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                              style={{ transform: showSavedIps ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                              <polyline points="6,9 12,15 18,9" />
                            </svg>
                          </button>
                        )}
                        {showSavedIps && savedIps.length > 0 && (
                          <div
                            style={{
                              position: 'absolute', top: '100%', right: 0, left: 42,
                              marginTop: 4, zIndex: 30,
                              background: '#2a2a2e',
                              border: '1px solid rgba(108, 140, 255, 0.35)',
                              borderRadius: 4,
                              boxShadow: '0 6px 14px rgba(0,0,0,0.45)',
                              maxHeight: 180, overflowY: 'auto',
                            }}
                          >
                            {savedIps.map((entry, idx) => {
                              const dev = devices.find((d) => d.id === entry.udid);
                              const label = dev?.name || (entry as any).name || (entry.udid ? entry.udid.slice(0, 10) : entry.ip);
                              return (
                                <div
                                  key={`${entry.ip}:${entry.port}:${idx}`}
                                  onClick={() => {
                                    setTunnelIp(entry.ip);
                                    setTunnelPort(String(entry.port));
                                    setShowSavedIps(false);
                                  }}
                                  style={{
                                    padding: '6px 10px', cursor: 'pointer', fontSize: 11,
                                    borderBottom: '1px solid #333',
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                  }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                                >
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {label}
                                    </div>
                                    <div style={{ fontSize: 10, opacity: 0.55, fontFamily: 'monospace' }}>
                                      {entry.ip}:{entry.port}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    title={t('wifi.recent_ip_delete_tooltip')}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeSavedIp(entry.ip, entry.port);
                                    }}
                                    style={{
                                      flexShrink: 0, padding: '2px 4px', lineHeight: 0,
                                      background: 'transparent', border: 'none', color: '#e07a7a',
                                      opacity: 0.65, cursor: 'pointer', borderRadius: 3,
                                    }}
                                  >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                      <line x1="18" y1="6" x2="6" y2="18" />
                                      <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 6 }}>
                        <span style={{ opacity: 0.7, width: 36 }}>Port</span>
                        <input
                          type="text" className="search-input" placeholder="49152"
                          value={tunnelPort} onChange={(e) => setTunnelPort(e.target.value)}
                          style={{ flex: 1, fontSize: 12, paddingLeft: 10 }} disabled={tunnelConnecting || portScanning}
                          title={t('wifi.port_empty_hint')}
                        />
                        <button
                          className="action-btn"
                          style={{ padding: '4px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                          disabled={tunnelConnecting || portScanning}
                          title={t('wifi.port_scan_tooltip')}
                          onClick={async () => {
                            const ip = tunnelIp.trim();
                            if (!ip) {
                              setTunnelError(t('wifi.ip_required_for_scan'));
                              return;
                            }
                            setTunnelError(null);
                            setPortScanning(true);
                            try {
                              const res = await wifiTunnelFindPort(ip);
                              if (!res.ports || res.ports.length === 0) {
                                setTunnelError(t('wifi.port_scan_no_hit'));
                              } else {
                                setTunnelPort(String(res.ports[0]));
                              }
                            } catch (err: any) {
                              setTunnelError(err.message || t('wifi.port_scan_failed'));
                            } finally {
                              setPortScanning(false);
                            }
                          }}
                        >
                          {portScanning ? t('wifi.port_scanning_short') : t('wifi.port_scan_button')}
                        </button>
                      </label>
                      <button
                        className="action-btn primary"
                        onClick={async () => {
                          const ip = tunnelIp.trim();
                          if (!ip) {
                            setTunnelError(t('wifi.ip_required_for_scan'));
                            return;
                          }
                          setTunnelError(null);
                          setTunnelConnecting(true);
                          // iOS rebinds its RemotePairing port across reboots /
                          // network changes, so a single guessed (or stale
                          // recent-list) port often fails while a different
                          // open port is the live one (issue #33). One call is
                          // enough now: the backend tries the entered port
                          // first, then re-scans the dynamic range itself and
                          // walks whatever it finds, reporting back the port
                          // that actually handshook.
                          let connectedPort: number | null = null;
                          let lastErr: any = null;
                          try {
                            const entered = parseInt(tunnelPort);
                            const primary = Number.isFinite(entered) && entered > 0 ? entered : 49152;
                            try {
                              const res = await onStartWifiTunnel(ip, primary);
                              connectedPort = Number(res?.port) > 0 ? Number(res.port) : primary;
                            } catch (err: any) {
                              lastErr = err;
                            }
                            if (connectedPort !== null) {
                              setTunnelPort(String(connectedPort));
                              // Legacy single-entry keys — kept so the IP / Port
                              // input fields pre-fill correctly next launch. The
                              // savedips multi-entry list is written by
                              // useDevice.startWifiTunnel for every code path.
                              localStorage.setItem('locwarp.tunnel.ip', ip);
                              localStorage.setItem('locwarp.tunnel.port', String(connectedPort));
                              refreshSavedIps();
                            } else {
                              setTunnelError(lastErr?.message || t('wifi.port_scan_no_hit'));
                            }
                          } finally {
                            setPortScanning(false);
                            setTunnelConnecting(false);
                          }
                        }}
                        disabled={tunnelConnecting || portScanning}
                        style={{
                          width: '100%', fontSize: 13, fontWeight: 600, padding: '9px 12px',
                          borderRadius: 7, border: 'none',
                          background: (tunnelConnecting || portScanning) ? 'rgba(108,140,255,0.45)' : 'linear-gradient(135deg, #6c8cff 0%, #4f6fe8 100%)',
                          color: '#fff', cursor: (tunnelConnecting || portScanning) ? 'wait' : 'pointer',
                          boxShadow: (tunnelConnecting || portScanning) ? 'none' : '0 4px 14px rgba(108,140,255,0.45)',
                          letterSpacing: '0.02em', transition: 'all 0.15s',
                        }}
                      >
                        {(tunnelConnecting || portScanning) ? (
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83" />
                            </svg>
                            {portScanning ? t('wifi.port_scanning') : t('wifi.tunnel_establishing')}
                          </span>
                        ) : t('wifi.tunnel_start')}
                      </button>
                      {tunnelError && (
                        <div style={{ fontSize: 11, color: '#f44336', marginTop: 4, padding: '4px 6px', background: 'rgba(244,67,54,0.1)', borderRadius: 3 }}>
                          {tunnelError}
                        </div>
                      )}
                      <div style={{ fontSize: 10, opacity: 0.4, marginTop: 6 }}>
                        {t('wifi.tunnel_admin_hint')}
                      </div>
                    </div>
                  )}
                </>
              )}

            </div>
          )}
        </div>
      )}

      {showWifiWarning && createPortal(
        <div
          onClick={() => setShowWifiWarning(false)}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)', borderRadius: 14,
              padding: 26, maxWidth: 560, width: '100%',
              maxHeight: '80vh', overflowY: 'auto',
              color: '#e8e8e8',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(255, 193, 7, 0.15)', color: '#ffc107',
                fontSize: 20, fontWeight: 700, border: '1px solid rgba(255,193,7,0.5)',
                flexShrink: 0,
              }}>!</span>
              <strong style={{ fontSize: 16 }}>{t('wifi.warning_title')}</strong>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-line', opacity: 0.92 }}>
              {t('wifi.warning_body')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button
                onClick={() => setShowWifiWarning(false)}
                style={{
                  padding: '8px 20px', fontSize: 13, borderRadius: 5,
                  background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer',
                  fontWeight: 600,
                }}
              >{t('wifi.warning_ok')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showRepairConfirm && createPortal(
        <div
          onClick={() => { if (repairState !== 'running') setShowRepairConfirm(false); }}
          className="anim-fade-in"
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(8, 10, 20, 0.55)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="anim-scale-in"
            style={{
              background: 'rgba(26, 29, 39, 0.96)',
              backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
              border: '1px solid rgba(108, 140, 255, 0.2)', borderRadius: 14,
              padding: 26, maxWidth: 460, width: '100%',
              color: '#e8e8e8',
              boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 32, height: 32, borderRadius: '50%',
                background: 'rgba(108, 140, 255, 0.15)', color: '#6c8cff',
                fontSize: 18, fontWeight: 700, border: '1px solid rgba(108,140,255,0.5)',
                flexShrink: 0,
              }}>↻</span>
              <strong style={{ fontSize: 15 }}>{t('wifi.repair_confirm_title')}</strong>
            </div>

            {repairState === 'idle' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-line', opacity: 0.92 }}>
                  {t('wifi.repair_confirm_body')}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                  <button
                    onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}
                  >{t('wifi.repair_cancel')}</button>
                  <button
                    onClick={handleRepair}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  >{t('wifi.repair_ok')}</button>
                </div>
              </>
            )}

            {repairState === 'running' && (
              <div style={{ fontSize: 13, lineHeight: 1.7, textAlign: 'center', padding: '20px 0' }}>
                <div style={{
                  width: 32, height: 32, margin: '0 auto 12px',
                  border: '3px solid rgba(108,140,255,0.25)',
                  borderTopColor: '#6c8cff', borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <div style={{ color: '#ffc107' }}>{t('wifi.repair_running')}</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}

            {repairState === 'success' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: '#4caf50' }}>
                  {t('wifi.repair_success')}
                </div>
                {repairMessage && (
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>{repairMessage}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                  <button
                    onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  >{t('wifi.warning_ok')}</button>
                </div>
              </>
            )}

            {repairState === 'failed' && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: '#ff6b6b' }}>
                  {t('wifi.repair_failed')}
                </div>
                {repairMessage && (
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8, padding: 8,
                    background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.3)',
                    borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{repairMessage}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
                  <button
                    onClick={() => setShowRepairConfirm(false)}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: 'transparent', color: '#bbb', border: '1px solid #444', cursor: 'pointer' }}
                  >{t('wifi.repair_cancel')}</button>
                  <button
                    onClick={handleRepair}
                    style={{ padding: '7px 16px', fontSize: 12, borderRadius: 5,
                      background: '#6c8cff', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                  >{t('wifi.repair_ok')}</button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default DeviceStatus;
