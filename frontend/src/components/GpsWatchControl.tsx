import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CoordinateAutoDetector, type Coordinate } from '../utils/coordinateDetector'
import type { GpsWatchEvent, GpsWatchRegion } from '../types/electron'

type WatchPhase =
  | 'idle'
  | 'selecting'
  | 'starting'
  | 'baseline'
  | 'watching'
  | 'teleporting'
  | 'stopping'
  | 'ambiguous'
  | 'error'

type GpsQueuePolicy = 'latest' | 'complete'

interface WatchStats {
  queued: number
  succeeded: number
  dropped: number
  expired: number
  framesSkipped: number
}

const GPS_QUEUE_POLICY_KEY = 'locwarp.gps_watch_queue_policy'
const EMPTY_STATS: WatchStats = { queued: 0, succeeded: 0, dropped: 0, expired: 0, framesSkipped: 0 }

const storedQueuePolicy = (): GpsQueuePolicy => {
  try {
    return localStorage.getItem(GPS_QUEUE_POLICY_KEY) === 'complete' ? 'complete' : 'latest'
  } catch {
    return 'latest'
  }
}

const createDetector = (queuePolicy: GpsQueuePolicy) => new CoordinateAutoDetector({
  stabilityFrames: 2,
  distanceMeters: 20,
  roundDecimals: 5,
  minIntervalMs: 450,
  continuous: true,
  queuePolicy,
  queueMaxAgeMs: 3000,
  // Vision supplies a confidence score for every parsed coordinate. Keep
  // automatic teleports conservative so low-confidence OCR cannot move a
  // device just because the watcher is running in the faster mode.
  minConfidence: 0.9,
  requireConfidence: true,
})

interface Props {
  isConnected: boolean
  isRouteRunning: boolean
  targetUdid: string | null
  onTeleport: (coordinate: Coordinate, targetUdid: string) => Promise<void>
  onShowToast: (message: string, duration?: number) => void
}

const formatCoordinate = (coordinate: Coordinate): string =>
  `${coordinate.lat.toFixed(6)}, ${coordinate.lng.toFixed(6)}`

const errorMessage = (event: GpsWatchEvent): string => {
  if (event.code === 'permission_denied' || event.code === 'screen_recording_denied') {
    return '需要允許 LocWarp 使用「螢幕與系統錄音」權限，授權後請重新啟動 LocWarp。'
  }
  return event.message || 'GPS 畫面監看發生錯誤'
}

const GpsWatchControl: React.FC<Props> = ({
  isConnected,
  isRouteRunning,
  targetUdid,
  onTeleport,
  onShowToast,
}) => {
  const [phase, setPhase] = useState<WatchPhase>('idle')
  const [detail, setDetail] = useState('框選畫面上的 GPS，自動瞬移')
  const [ambiguous, setAmbiguous] = useState<Coordinate[]>([])
  const [lastCoordinate, setLastCoordinate] = useState<Coordinate | null>(null)
  const [queuePolicy, setQueuePolicy] = useState<GpsQueuePolicy>(storedQueuePolicy)
  const [stats, setStats] = useState<WatchStats>(EMPTY_STATS)
  const detectorRef = useRef(createDetector(queuePolicy))
  const teleportRef = useRef(onTeleport)
  const connectedRef = useRef(isConnected)
  const routeRunningRef = useRef(isRouteRunning)
  const stoppingRef = useRef(false)
  const sessionRef = useRef(0)
  const targetUdidRef = useRef<string | null>(null)
  const ignoreStoppedRef = useRef(false)
  const queuePolicyRef = useRef<GpsQueuePolicy>(queuePolicy)
  const statsRef = useRef<WatchStats>(EMPTY_STATS)
  const lastPublishedStatusRef = useRef('')

  useEffect(() => { teleportRef.current = onTeleport }, [onTeleport])
  useEffect(() => { connectedRef.current = isConnected }, [isConnected])
  useEffect(() => { routeRunningRef.current = isRouteRunning }, [isRouteRunning])

  const publishStats = useCallback((patch: Partial<WatchStats> = {}) => {
    const snapshot = detectorRef.current.getSnapshot()
    const next: WatchStats = {
      ...statsRef.current,
      ...patch,
      queued: patch.queued ?? snapshot.queued.length,
    }
    statsRef.current = next
    setStats(next)
    const payload = {
      mode: queuePolicyRef.current,
      queued: next.queued,
      succeeded: next.succeeded,
      skipped: next.dropped + next.expired,
      framesSkipped: next.framesSkipped,
    }
    const signature = JSON.stringify(payload)
    if (signature === lastPublishedStatusRef.current) return
    lastPublishedStatusRef.current = signature
    void window.electronAPI?.gpsWatch?.updateStatus(payload).catch(() => {})
  }, [])

  const changeQueuePolicy = useCallback((next: GpsQueuePolicy) => {
    queuePolicyRef.current = next
    setQueuePolicy(next)
    detectorRef.current = createDetector(next)
    try { localStorage.setItem(GPS_QUEUE_POLICY_KEY, next) } catch { /* ignore */ }
  }, [])

  const stop = useCallback(async (reveal = false, resetUi = true) => {
    stoppingRef.current = true
    ignoreStoppedRef.current = true
    sessionRef.current += 1
    detectorRef.current.reset()
    if (resetUi) {
      setPhase('stopping')
      setDetail('正在停止 GPS 畫面監看…')
    }
    try {
      await window.electronAPI?.gpsWatch?.stop()
      if (reveal) await window.electronAPI?.gpsWatch?.showMain()
    } finally {
      stoppingRef.current = false
      if (resetUi) {
        setPhase('idle')
        setDetail('框選畫面上的 GPS，自動瞬移')
      }
    }
  }, [])

  useEffect(() => {
    const gpsWatch = window.electronAPI?.gpsWatch
    if (!gpsWatch) return
    return gpsWatch.onEvent((event) => {
      if (stoppingRef.current && event.event !== 'stopped') return
      if (event.event === 'stopping') {
        // A global Esc/Alt+Shift+G stop originates in Electron rather than
        // this component. Invalidate the current frame epoch immediately so
        // trailing helper frames and an in-flight teleport acknowledgement
        // cannot revive the watcher after the user has left the mode.
        stoppingRef.current = true
        sessionRef.current += 1
        detectorRef.current.reset()
        setPhase('stopping')
        setDetail('正在停止 GPS 畫面監看…')
        return
      }
      if (event.event === 'permission') {
        if (event.state === 'denied') {
          const message = '需要允許 LocWarp 使用「螢幕與系統錄音」權限，授權後請重新啟動 LocWarp。'
          setPhase('error')
          setDetail(message)
          onShowToast(message, 10000)
          void stop(true, false)
        } else {
          setDetail(event.state === 'granted' ? '螢幕擷取權限已允許' : '正在確認螢幕擷取權限…')
        }
        return
      }
      if (event.event === 'warning') {
        const message = event.message || 'GPS 畫面監看有一個可恢復的提醒'
        setDetail(message)
        onShowToast(message, 8000)
        return
      }
      if (event.event === 'started') {
        if (stoppingRef.current) return
        setPhase('baseline')
        setDetail('建立畫面基線中，目前座標不會觸發')
        return
      }
      if (event.event === 'frame') {
        if (stoppingRef.current) return
        // Prefer the helper's parsed candidates so each Vision confidence
        // score reaches the detector. Joining all OCR text would both lose
        // confidence and risk pairing unrelated decimals across lines.
        const frameInput = event.candidates?.length
          ? event.candidates
          : (event.texts ?? [])
        const result = detectorRef.current.observe(frameInput)
        publishStats({
          dropped: result.droppedCount,
          expired: result.expiredCount ?? 0,
          framesSkipped: event.captureDroppedCount ?? statsRef.current.framesSkipped,
        })
        if (result.phase === 'baseline') {
          setPhase('watching')
          setDetail(`監看中 · 已略過目前 ${result.candidates.length} 筆座標`)
          return
        }
        if (result.phase === 'ambiguous') {
          // The continuous session processes multi-coordinate frames in a
          // stable, deterministic order. Keep this branch as a defensive
          // fallback for an older detector/runtime without stopping the scan.
          setPhase('watching')
          setDetail(`監看中 · 發現 ${result.newCandidates.length} 筆新座標，將依序處理`)
          return
        }
        if (result.phase === 'pending' && result.coordinate) {
          setDetail(`確認中 · ${formatCoordinate(result.coordinate)}`)
          return
        }
        if (!result.ready || !result.coordinate || result.attemptId === undefined) return

        if (!connectedRef.current || routeRunningRef.current) {
          detectorRef.current.markFailed(result.attemptId)
          setPhase('error')
          setDetail(routeRunningRef.current ? '路線執行中，已停止自動瞬移' : '裝置未連線，已停止監看')
          void stop(true, false)
          return
        }

        const coordinate = result.coordinate
        const attemptId = result.attemptId
        const session = sessionRef.current
        setPhase('teleporting')
        setDetail(`瞬移中 · ${formatCoordinate(coordinate)}`)
        const sessionTarget = targetUdidRef.current
        if (!sessionTarget) {
          detectorRef.current.markFailed(attemptId)
          setPhase('error')
          setDetail('目標裝置已斷線，GPS 畫面監看已停止')
          void stop(true, false)
          return
        }
        void teleportRef.current(coordinate, sessionTarget).then(() => {
          if (session !== sessionRef.current || stoppingRef.current) return
          detectorRef.current.markSucceeded(attemptId)
          publishStats({ succeeded: statsRef.current.succeeded + 1 })
          setLastCoordinate(coordinate)
          setPhase('watching')
          setDetail(`監看中 · 上次 ${formatCoordinate(coordinate)}`)
        }).catch((error: any) => {
          if (session !== sessionRef.current || stoppingRef.current) return
          detectorRef.current.markFailed(attemptId)
          const message = error?.message || '瞬移失敗'
          setPhase('error')
          setDetail(message)
          onShowToast(`GPS 自動瞬移失敗：${message}`, 8000)
          void stop(true, false)
        })
        return
      }
      if (event.event === 'error') {
        const message = errorMessage(event)
        setPhase('error')
        setDetail(message)
        onShowToast(message, 10000)
        void stop(true, false)
        return
      }
      if (event.event === 'stopped') {
        if (ignoreStoppedRef.current) return
        stoppingRef.current = false
        setPhase('idle')
        setDetail(event.reason === 'hotkey' ? '已由快捷鍵停止 GPS 監看' : 'GPS 畫面監看已停止')
      }
    })
  }, [onShowToast, publishStats, stop])

  useEffect(() => {
    void window.electronAPI?.gpsWatch?.status().then((status) => {
      if (status.state === 'watching' || status.state === 'starting') {
        setPhase(status.state === 'watching' ? 'watching' : 'starting')
        setDetail(status.state === 'watching' ? 'GPS 畫面監看中' : '正在啟動 GPS 畫面監看…')
      }
    })
  }, [])

  useEffect(() => {
    const isActive = phase === 'selecting'
      || phase === 'starting'
      || phase === 'baseline'
      || phase === 'watching'
      || phase === 'teleporting'
    if (!isActive || (isConnected && !isRouteRunning)) return
    const message = isRouteRunning
      ? '路線已開始，GPS 畫面監看已停止'
      : '裝置已斷線，GPS 畫面監看已停止'
    setPhase('error')
    setDetail(message)
    onShowToast(message, 8000)
    void stop(true, false)
  }, [isConnected, isRouteRunning, onShowToast, phase, stop])

  useEffect(() => {
    const isActive = phase === 'selecting'
      || phase === 'starting'
      || phase === 'baseline'
      || phase === 'watching'
      || phase === 'teleporting'
    if (!isActive || !targetUdidRef.current || targetUdid === targetUdidRef.current) return
    const message = '目標 iPhone 已變更，GPS 畫面監看已停止'
    setPhase('error')
    setDetail(message)
    onShowToast(message, 8000)
    void stop(true, false)
  }, [onShowToast, phase, stop, targetUdid])

  const start = useCallback(async () => {
    const gpsWatch = window.electronAPI?.gpsWatch
    if (!gpsWatch) {
      onShowToast('此版本沒有 GPS 畫面監看模組')
      return
    }
    if (!isConnected) {
      onShowToast('請先連線一台 iPhone')
      return
    }
    if (isRouteRunning) {
      onShowToast('請先停止目前路線，再啟用自動瞬移')
      return
    }

    stoppingRef.current = false
    ignoreStoppedRef.current = false
    const session = sessionRef.current + 1
    sessionRef.current = session
    targetUdidRef.current = targetUdid
    detectorRef.current = createDetector(queuePolicyRef.current)
    statsRef.current = EMPTY_STATS
    setStats(EMPTY_STATS)
    lastPublishedStatusRef.current = ''
    publishStats(EMPTY_STATS)
    setAmbiguous([])
    setPhase('selecting')
    setDetail('請在畫面上拖曳 GPS 感應區')
    try {
      const selection = await gpsWatch.selectRegion()
      if (
        session !== sessionRef.current
        || stoppingRef.current
        || !connectedRef.current
        || routeRunningRef.current
      ) {
        await gpsWatch.showMain()
        return
      }
      if (!selection.ok || !selection.region) {
        setPhase('idle')
        setDetail(selection.code === 'cancelled' ? '已取消框選' : '無法開啟框選畫面')
        return
      }
      setPhase('starting')
      setDetail('正在啟動本機 OCR…')
      const started = await gpsWatch.start(selection.region as GpsWatchRegion)
      if (started.ok) return
      await gpsWatch.showMain()
      setPhase('error')
      const message = started.code === 'helper_missing'
        ? '找不到 GPS OCR helper，請重新打包安裝 LocWarp'
        : `無法啟動 GPS 監看：${started.code || 'unknown'}`
      setDetail(message)
      onShowToast(message, 8000)
    } catch (error: any) {
      await gpsWatch.showMain().catch(() => {})
      await gpsWatch.stop().catch(() => {})
      sessionRef.current += 1
      stoppingRef.current = false
      detectorRef.current.reset()
      setPhase('error')
      const message = error?.message || 'GPS 框選或啟動失敗'
      setDetail(message)
      onShowToast(message, 8000)
    }
  }, [isConnected, isRouteRunning, onShowToast, targetUdid])

  const chooseAmbiguous = useCallback(async (coordinate: Coordinate) => {
    setPhase('teleporting')
    setDetail(`瞬移中 · ${formatCoordinate(coordinate)}`)
    try {
      const sessionTarget = targetUdidRef.current
      if (!sessionTarget) throw new Error('目標 iPhone 已斷線')
      await onTeleport(coordinate, sessionTarget)
      setLastCoordinate(coordinate)
      setAmbiguous([])
      setPhase('idle')
      setDetail(`已瞬移 · ${formatCoordinate(coordinate)}；可重新框選`)
    } catch (error: any) {
      const message = error?.message || '瞬移失敗'
      setPhase('error')
      setDetail(message)
      onShowToast(`GPS 自動瞬移失敗：${message}`, 8000)
    }
  }, [onTeleport, onShowToast])

  const active = phase !== 'idle' && phase !== 'error' && phase !== 'ambiguous'
  const unavailable = window.electronAPI?.platform !== 'darwin'
  const skipped = stats.dropped + stats.expired

  return (
    <div className={`gps-watch-control phase-${phase}`}>
      <div className="gps-watch-mode" aria-label="GPS 掃描模式">
        <button
          className={queuePolicy === 'latest' ? 'selected' : ''}
          disabled={active}
          aria-pressed={queuePolicy === 'latest'}
          onClick={() => changeQueuePolicy('latest')}
          title="只保留最新穩定座標；舊座標 3 秒後過期"
        >極速</button>
        <button
          className={queuePolicy === 'complete' ? 'selected' : ''}
          disabled={active}
          aria-pressed={queuePolicy === 'complete'}
          onClick={() => changeQueuePolicy('complete')}
          title="依序處理 3 秒內出現的所有穩定座標"
        >完整</button>
      </div>
      <button
        className={`gps-watch-button${active ? ' active' : ''}`}
        onClick={() => { active ? void stop(false) : void start() }}
        disabled={unavailable || phase === 'selecting' || phase === 'starting' || phase === 'teleporting' || phase === 'stopping'}
        title={unavailable ? 'GPS 畫面監看目前只支援 macOS' : detail}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
          <circle cx="12" cy="12" r="2.5" />
          <path d="M12 7v2M12 15v2M7 12h2M15 12h2" />
        </svg>
        <span>{active ? '停止 GPS 掃描' : '框選 GPS 自動瞬移'}</span>
        {active && <i aria-hidden />}
      </button>
      <div className="gps-watch-detail">
        <span>{detail}</span>
        {active && (
          <span className="gps-watch-stats">
            <b>{queuePolicy === 'latest' ? '極速' : '完整'}</b>
            <em>排 {stats.queued}</em>
            <em>成 {stats.succeeded}</em>
            <em>略 {skipped}</em>
            {stats.framesSkipped > 0 && <em>幀 {stats.framesSkipped}</em>}
          </span>
        )}
        {lastCoordinate && phase === 'idle' && (
          <code>{formatCoordinate(lastCoordinate)}</code>
        )}
      </div>
      {ambiguous.length > 1 && (
        <div className="gps-watch-ambiguous">
          <strong>選擇要瞬移的座標</strong>
          {ambiguous.map((coordinate) => (
            <button
              key={formatCoordinate(coordinate)}
              onClick={() => { void chooseAmbiguous(coordinate) }}
            >
              {formatCoordinate(coordinate)}
            </button>
          ))}
          <button className="cancel" onClick={() => { setAmbiguous([]); setPhase('idle') }}>取消</button>
        </div>
      )}
    </div>
  )
}

export default GpsWatchControl
