import React, { useCallback, useEffect, useState } from 'react'
import { getSystemDiagnostics, type SystemDiagnostics } from '../services/api'
import { useT } from '../i18n'
import { BRAND } from '../config/brand'

type CaptureDiagnostic = { supported: boolean; state: string } | null

const valueOrUnknown = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : String(value)

const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds || 0))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const missingLabel = (udids: string[]): string => udids
  .map((udid) => String(udid || '').slice(-6).toUpperCase())
  .filter(Boolean)
  .join(', ')

const SystemDiagnosticsPanel: React.FC = () => {
  const t = useT()
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null)
  const [capture, setCapture] = useState<CaptureDiagnostic>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const runtime = window.electronAPI?.runtimeVersions

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [system, gpsWatch] = await Promise.all([
        getSystemDiagnostics(),
        window.electronAPI?.gpsWatch?.status().catch(() => null) ?? Promise.resolve(null),
      ])
      setDiagnostics(system)
      setCapture(gpsWatch ? { supported: gpsWatch.supported, state: gpsWatch.state } : null)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      if (!active) return
      await refresh()
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 10_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const overallClass = error ? 'error' : diagnostics?.status === 'healthy' ? 'healthy' : 'warning'
  const overallLabel = error
    ? t('diagnostics.unavailable')
    : diagnostics?.status === 'healthy'
      ? t('diagnostics.healthy')
      : diagnostics
        ? t('diagnostics.attention')
        : t('diagnostics.checking')
  const checkedAt = diagnostics?.checked_at_unix
    ? new Date(diagnostics.checked_at_unix * 1000).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    : null
  const captureProven = capture?.supported === true && capture.state === 'watching'

  return (
    <>
      <div className="diagnostics-summary">
        <span className={`diagnostics-state ${overallClass}`}>
          <span className="diagnostics-state-dot" />
          {overallLabel}
        </span>
        <button type="button" className="ios-pill" onClick={() => void refresh()} disabled={loading}>
          {loading ? t('diagnostics.checking') : t('diagnostics.refresh')}
        </button>
      </div>

      {error && <div className="diagnostics-error">{error}</div>}

      <div className="diagnostics-grid" aria-label={t('diagnostics.core_versions')}>
        <span>{t('diagnostics.app')}</span><strong>{BRAND.version}</strong>
        <span>{t('diagnostics.backend')}</span><strong>{valueOrUnknown(diagnostics?.app_version)}</strong>
        <span>Electron / Chromium</span><strong>{valueOrUnknown(runtime?.electron)} / {valueOrUnknown(runtime?.chromium)}</strong>
        <span>Node / Python</span><strong>{valueOrUnknown(runtime?.node)} / {valueOrUnknown(diagnostics?.platform.python)}</strong>
        <span>pymobiledevice3</span><strong>{valueOrUnknown(diagnostics?.dependencies.pymobiledevice3)}</strong>
        <span>pmd-pytcp</span><strong>{valueOrUnknown(diagnostics?.dependencies.pmd_pytcp)}</strong>
        <span>{t('diagnostics.platform')}</span>
        <strong>
          {valueOrUnknown(diagnostics?.platform.system || runtime?.platform)} · {valueOrUnknown(diagnostics?.platform.machine || runtime?.arch)}
        </strong>
      </div>

      <div className="diagnostics-checks">
        <div className="diagnostics-check-row">
          <span>{t('diagnostics.backend_health')}</span>
          <strong className={error ? 'is-error' : diagnostics ? 'is-ok' : ''}>
            {error ? t('diagnostics.unavailable') : diagnostics ? t('diagnostics.healthy') : t('diagnostics.checking')}
          </strong>
        </div>
        <div className="diagnostics-check-row">
          <span>{t('diagnostics.devices')}</span>
          <strong className={diagnostics?.counts.recovering_devices ? 'is-warning' : ''}>
            {diagnostics
              ? `${diagnostics.counts.connected_devices}/${diagnostics.counts.max_devices ?? '—'} · GPS ${diagnostics.counts.gps_ready_devices} · ${t('diagnostics.recovering')} ${diagnostics.counts.recovering_devices}`
              : '—'}
          </strong>
        </div>
        <div className="diagnostics-check-row">
          <span>{t('diagnostics.wifi_tunnels')}</span>
          <strong>{diagnostics ? diagnostics.counts.wifi_tunnels : '—'}</strong>
        </div>
        <div className="diagnostics-check-row">
          <span>{t('diagnostics.screen_capture')}</span>
          <strong className={captureProven ? 'is-ok' : capture ? 'is-warning' : ''}>
            {capture
              ? captureProven
                ? `${t('diagnostics.supported')} · ${capture.state}`
                : `${capture.supported ? t('diagnostics.supported') : t('diagnostics.unsupported')} · ${t('diagnostics.not_verified')} · ${capture.state}`
              : t('diagnostics.not_verified')}
          </strong>
        </div>
        <div className="diagnostics-check-row">
          <span>{t('diagnostics.uptime')}</span>
          <strong>{diagnostics ? formatDuration(diagnostics.uptime_seconds) : '—'}</strong>
        </div>
        {diagnostics?.group && (
          <div className="diagnostics-check-row">
            <span>{t('diagnostics.strict_group')}</span>
            <strong className={diagnostics.group.missing_udids.length ? 'is-warning' : ''}>
              {diagnostics.group.ready_count}/{diagnostics.group.expected_count}
              {` · ${diagnostics.group.last_ack_delta_ms != null ? diagnostics.group.last_ack_delta_ms.toFixed(1) : '—'} ms`}
              {diagnostics.group.missing_udids.length > 0
                ? ` · ${t('diagnostics.missing')} ${missingLabel(diagnostics.group.missing_udids)}`
                : ''}
            </strong>
          </div>
        )}
      </div>

      <div className="diagnostics-footnote">
        {checkedAt ? `${t('diagnostics.last_checked')} ${checkedAt}` : t('diagnostics.not_verified')}
      </div>
    </>
  )
}

export default SystemDiagnosticsPanel
