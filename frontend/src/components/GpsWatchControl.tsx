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

export type GpsWatchTargetMode = 'primary' | 'all'

export interface GpsWatchTeleportResult {
  ok: string[]
  failed: Array<{ udid: string; reason: string }>
}

interface WatchStats {
  queued: number
  succeeded: number
  dropped: number
  expired: number
  framesSkipped: number
}

const GPS_QUEUE_POLICY_KEY = 'locwarp.gps_watch_queue_policy'
const GPS_WATCH_TARGET_MODE_KEY = 'locwarp.gps_watch_target_mode'
const EMPTY_STATS: WatchStats = { queued: 0, succeeded: 0, dropped: 0, expired: 0, framesSkipped: 0 }
// Keep two matching OCR frames as the safety gate. This interval only limits
// how quickly a confirmed new coordinate may follow the previous one.
const GPS_WATCH_MIN_INTERVAL_MS = 300

const storedQueuePolicy = (): GpsQueuePolicy => {
  try {
    return localStorage.getItem(GPS_QUEUE_POLICY_KEY) === 'complete' ? 'complete' : 'latest'
  } catch {
    return 'latest'
  }
}

const storedTargetMode = (): GpsWatchTargetMode => {
  try {
    return localStorage.getItem(GPS_WATCH_TARGET_MODE_KEY) === 'all' ? 'all' : 'primary'
  } catch {
    return 'primary'
  }
}

const uniqueSortedUdids = (udids: string[]): string[] =>
  Array.from(new Set(udids.filter(Boolean))).sort()

const createDetector = (queuePolicy: GpsQueuePolicy) => new CoordinateAutoDetector({
  stabilityFrames: 2,
  // A screen-watch session is explicitly started by the user. Let its first
  // stable OCR coordinate trigger after the same two-frame safety gate; the
  // detector's default remains the conservative first-frame baseline.
  triggerInitialCandidate: true,
  distanceMeters: 20,
  roundDecimals: 5,
  minIntervalMs: GPS_WATCH_MIN_INTERVAL_MS,
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
  connectedUdids?: string[]
  onTeleport: (coordinate: Coordinate, targetUdid: string) => Promise<void>
  onTeleportAll?: (coordinate: Coordinate, targetUdids: string[]) => Promise<GpsWatchTeleportResult>
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
  connectedUdids = [],
  onTeleport,
  onTeleportAll,
  onShowToast,
}) => {
  const [phase, setPhase] = useState<WatchPhase>('idle')
  const [detail, setDetail] = useState('支援十進位、度分、度分秒，自動轉換')
  const [ambiguous, setAmbiguous] = useState<Coordinate[]>([])
  const [lastCoordinate, setLastCoordinate] = useState<Coordinate | null>(null)
  const [queuePolicy, setQueuePolicy] = useState<GpsQueuePolicy>(storedQueuePolicy)
  const [targetMode, setTargetMode] = useState<GpsWatchTargetMode>(storedTargetMode)
  const [delivery, setDelivery] = useState<{ ok: number; total: number; failed: number } | null>(null)
  const [stats, setStats] = useState<WatchStats>(EMPTY_STATS)
  const detectorRef = useRef(createDetector(queuePolicy))
  const teleportRef = useRef(onTeleport)
  const connectedRef = useRef(isConnected)
  const connectedUdidsRef = useRef<string[]>(connectedUdids)
  const routeRunningRef = useRef(isRouteRunning)
  const stoppingRef = useRef(false)
  const sessionRef = useRef(0)
  const targetUdidRef = useRef<string | null>(null)
  const sessionTargetsRef = useRef<string[]>([])
  const targetModeRef = useRef<GpsWatchTargetMode>(targetMode)
  const teleportAllRef = useRef(onTeleportAll)
  // A group delivery is atomic from the watcher user's perspective. If one
  // member cannot accept the coordinate, preserve the n/N failure notice
  // through helper teardown instead of silently continuing with a divergent
  // subset of the phones.
  const terminalNoticeRef = useRef<string | null>(null)
  // Teardown is complete only after Electron reports `stopped` or status
  // reconciliation observes an idle helper. This replaces the old
  // ignoreStopped flag, which could swallow the only final event after Esc.
  const stopPendingRef = useRef(false)
  const queuePolicyRef = useRef<GpsQueuePolicy>(queuePolicy)
  const statsRef = useRef<WatchStats>(EMPTY_STATS)
  const lastPublishedStatusRef = useRef('')

  useEffect(() => { teleportRef.current = onTeleport }, [onTeleport])
  useEffect(() => { connectedRef.current = isConnected }, [isConnected])
  useEffect(() => { connectedUdidsRef.current = connectedUdids }, [connectedUdids])
  useEffect(() => { routeRunningRef.current = isRouteRunning }, [isRouteRunning])
  useEffect(() => { targetModeRef.current = targetMode }, [targetMode])
  useEffect(() => { teleportAllRef.current = onTeleportAll }, [onTeleportAll])

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

  const currentTargetUdids = useCallback((): string[] => {
    if (targetModeRef.current === 'all') {
      // All-mode is a strict group session: membership is captured at start
      // and cannot silently shrink or grow while OCR frames are in flight.
      return sessionTargetsRef.current.length > 0
        ? [...sessionTargetsRef.current]
        : uniqueSortedUdids(connectedUdidsRef.current)
    }
    return targetUdidRef.current ? [targetUdidRef.current] : []
  }, [])

  const changeTargetMode = useCallback((next: GpsWatchTargetMode) => {
    targetModeRef.current = next
    setTargetMode(next)
    try { localStorage.setItem(GPS_WATCH_TARGET_MODE_KEY, next) } catch { /* ignore */ }
  }, [])

  const changeQueuePolicy = useCallback((next: GpsQueuePolicy) => {
    queuePolicyRef.current = next
    setQueuePolicy(next)
    detectorRef.current = createDetector(next)
    try { localStorage.setItem(GPS_QUEUE_POLICY_KEY, next) } catch { /* ignore */ }
  }, [])

  const stop = useCallback(async (reveal = false, resetUi = true) => {
    // Capture the notice before teardown can emit `stopped` and clear the
    // ref. This lets strict group failures finish in `error` while ordinary
    // Esc/user stops still finish in `idle`.
    const terminalNotice = terminalNoticeRef.current
    stoppingRef.current = true
    stopPendingRef.current = true
    sessionRef.current += 1
    sessionTargetsRef.current = []
    detectorRef.current.reset()
    setDelivery(null)
    if (resetUi) {
      setPhase('stopping')
      setDetail('GPS 畫面監看已停止，正在釋放擷取資源…')
    }
    try {
      await window.electronAPI?.gpsWatch?.stop()
      if (reveal) await window.electronAPI?.gpsWatch?.showMain()
    } finally {
      stopPendingRef.current = false
      stoppingRef.current = false
      if (resetUi) {
        if (terminalNotice) {
          setPhase('error')
          setDetail(terminalNotice)
        } else {
          setPhase('idle')
          setDetail('支援十進位、度分、度分秒，自動轉換')
        }
      }
    }
  }, [])

  // Keep the group contract local to the renderer. Newer App code can use a
  // single backend-aware fan-out callback; older callers remain compatible by
  // falling back to parallel single-device callbacks with the same coordinate.
  const dispatchAll = useCallback(async (
    coordinate: Coordinate,
    targetUdids: string[],
  ): Promise<GpsWatchTeleportResult> => {
    if (teleportAllRef.current) {
      return teleportAllRef.current(coordinate, targetUdids)
    }
    const results = await Promise.allSettled(
      targetUdids.map((udid) => teleportRef.current(coordinate, udid)),
    )
    return {
      ok: results.flatMap((result, index) => result.status === 'fulfilled' ? [targetUdids[index]] : []),
      failed: results.flatMap((result, index) => result.status === 'rejected'
        ? [{ udid: targetUdids[index], reason: result.reason?.message || String(result.reason) }]
        : []),
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
        stopPendingRef.current = true
        sessionRef.current += 1
        detectorRef.current.reset()
        setPhase('stopping')
        setDetail('GPS 畫面監看已停止，正在釋放擷取資源…')
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
        setPhase('watching')
        setDetail('辨識中 · 第一筆座標也會在連續兩幀確認後瞬移')
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
        const modeForSession = targetModeRef.current
        const sessionTargets = currentTargetUdids()
        setPhase('teleporting')
        setDetail(modeForSession === 'all'
          ? `同步瞬移中 · ${formatCoordinate(coordinate)}`
          : `瞬移中 · ${formatCoordinate(coordinate)}`)
        if (sessionTargets.length === 0) {
          detectorRef.current.markFailed(attemptId)
          setPhase('error')
          setDetail('目標裝置已斷線，GPS 畫面監看已停止')
          void stop(true, false)
          return
        }
        const deliveryPromise = modeForSession === 'all'
          ? dispatchAll(coordinate, sessionTargets)
          : teleportRef.current(coordinate, sessionTargets[0]).then(() => ({
            ok: [sessionTargets[0]],
            failed: [],
          }))
        void deliveryPromise.then((outcome) => {
          if (session !== sessionRef.current || stoppingRef.current) return
          const succeeded = outcome.ok.length
          const failed = outcome.failed.length
          setDelivery({ ok: succeeded, total: sessionTargets.length, failed })
          const failureDetail = failed > 0
            ? outcome.failed
              .map((item) => `${item.udid.slice(0, 6)}: ${item.reason}`)
              .join('；')
            : ''

          // Group mode is deliberately strict: a partial fan-out is not a
          // successful observation. Stop the watcher before the next OCR
          // frame can move only the still-healthy phone, while keeping the
          // source screen visible (reveal=false) and reporting n/N.
          if (modeForSession === 'all' && failed > 0) {
            detectorRef.current.markFailed(attemptId)
            const message = `同步停止 · ${succeeded}/${sessionTargets.length} 台已送出${failureDetail ? ` · ${failureDetail}` : ''}`
            setLastCoordinate(coordinate)
            setPhase('error')
            setDetail(message)
            onShowToast(`GPS 同步瞬移部分失敗：${succeeded}/${sessionTargets.length} 台，已停止監看`, 8000)
            terminalNoticeRef.current = message
            void stop(false, true).catch(() => {})
            return
          }

          if (succeeded > 0) {
            detectorRef.current.markSucceeded(attemptId)
            publishStats({ succeeded: statsRef.current.succeeded + 1 })
          } else {
            detectorRef.current.markFailed(attemptId)
          }
          setLastCoordinate(coordinate)
          setPhase('watching')
          if (failed > 0) {
            setDetail(`監看中 · ${succeeded}/${sessionTargets.length} 台已送出 · ${failureDetail}`)
            onShowToast(`GPS 同步瞬移部分失敗：${succeeded}/${sessionTargets.length} 台`, 6000)
          } else {
            setDetail(modeForSession === 'all'
              ? `監看中 · ${succeeded}/${sessionTargets.length} 台已送出 · 上次 ${formatCoordinate(coordinate)}`
              : `監看中 · 上次 ${formatCoordinate(coordinate)}`)
          }
        }).catch((error: any) => {
          if (session !== sessionRef.current || stoppingRef.current) return
          detectorRef.current.markFailed(attemptId)
          const message = error?.message || '瞬移失敗'
          setPhase('error')
          setDetail(message)
          onShowToast(`GPS 自動瞬移失敗：${message}`, 8000)
          if (modeForSession === 'all') {
            terminalNoticeRef.current = message
            // Keep the watched source app in front for every strict-group
            // failure, including a server-side preflight rejection.
            void stop(false, true).catch(() => {})
          } else {
            void stop(true, false)
          }
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
        stopPendingRef.current = false
        stoppingRef.current = false
        const terminalNotice = terminalNoticeRef.current
        terminalNoticeRef.current = null
        if (terminalNotice) {
          setPhase('error')
          setDetail(terminalNotice)
        } else {
          setPhase('idle')
          setDetail(event.reason === 'escape' || event.reason === 'hotkey'
            ? '已由快捷鍵停止 GPS 監看'
            : 'GPS 畫面監看已停止')
        }
      }
    })
  }, [onShowToast, publishStats, stop])

  useEffect(() => {
    const gpsWatch = window.electronAPI?.gpsWatch
    if (!gpsWatch) return
    let cancelled = false
    void gpsWatch.status().then((status) => {
      if (cancelled) return
      if (status.state === 'watching' || status.state === 'starting') {
        setPhase(status.state === 'watching' ? 'watching' : 'starting')
        setDetail(status.state === 'watching' ? 'GPS 畫面監看中' : '正在啟動 GPS 畫面監看…')
      } else if (status.state === 'stopping') {
        stopPendingRef.current = true
        stoppingRef.current = true
        setPhase('stopping')
        setDetail('GPS 畫面監看已停止，正在釋放擷取資源…')
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Electron normally emits `stopped`, but reconcile against the authoritative
  // process state as a fallback. This covers the observed case where the
  // helper is already gone but the renderer missed the final IPC event.
  useEffect(() => {
    if (phase !== 'stopping') return
    const gpsWatch = window.electronAPI?.gpsWatch
    if (!gpsWatch) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const poll = async () => {
      let state: string | undefined
      try {
        state = (await gpsWatch.status()).state
      } catch {
        // Keep trying across a transient renderer/main-process IPC failure.
      }
      if (cancelled) return
      if (state === 'idle') {
        stopPendingRef.current = false
        stoppingRef.current = false
        setPhase('idle')
        setDetail('GPS 畫面監看已停止')
        return
      }
      // The main process has a bounded helper-stop path. Keep this last poll
      // window slightly longer than that path, without claiming idle while a
      // live helper is still reported as stopping.
      if (Date.now() - startedAt < 6000) {
        timer = setTimeout(() => { void poll() }, 150)
      }
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [phase])

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

  useEffect(() => {
    const isActive = phase === 'selecting'
      || phase === 'starting'
      || phase === 'baseline'
      || phase === 'watching'
      || phase === 'teleporting'
    if (!isActive || targetMode !== 'all' || sessionTargetsRef.current.length < 2) return
    const current = uniqueSortedUdids(connectedUdids)
    const expected = sessionTargetsRef.current
    if (current.length === expected.length && expected.every((udid) => current.includes(udid))) return
    const message = '同步群組裝置清單已變更，GPS 畫面監看已停止'
    setPhase('error')
    setDetail(message)
    onShowToast(message, 8000)
    terminalNoticeRef.current = message
    // Keep the source screen in front so the user can fix the connection
    // without LocWarp stealing focus while this watcher is torn down.
    void stop(false, true).catch(() => {})
  }, [connectedUdids, onShowToast, phase, stop, targetMode])

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
    stopPendingRef.current = false
    terminalNoticeRef.current = null
    const session = sessionRef.current + 1
    sessionRef.current = session
    targetUdidRef.current = targetUdid
    const initialTargets = targetModeRef.current === 'all'
      ? uniqueSortedUdids(connectedUdidsRef.current)
      : (targetUdid ? [targetUdid] : [])
    if (targetModeRef.current === 'all' && initialTargets.length < 2) {
      onShowToast('全部裝置模式至少需要兩台已連線的 iPhone')
      return
    }
    sessionTargetsRef.current = initialTargets
    detectorRef.current = createDetector(queuePolicyRef.current)
    statsRef.current = EMPTY_STATS
    setDelivery(null)
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
    const modeForSession = targetModeRef.current
    const sessionTargets = currentTargetUdids()
    setPhase('teleporting')
    setDetail(modeForSession === 'all'
      ? `同步瞬移中 · ${formatCoordinate(coordinate)}`
      : `瞬移中 · ${formatCoordinate(coordinate)}`)
    try {
      if (sessionTargets.length === 0) throw new Error('目標 iPhone 已斷線')
      if (modeForSession === 'all') {
        if (sessionTargets.length < 2) throw new Error('同步群組至少需要兩台已連線的 iPhone')
        const outcome = await dispatchAll(coordinate, sessionTargets)
        const succeeded = outcome.ok.length
        const failed = outcome.failed.length
        setDelivery({ ok: succeeded, total: sessionTargets.length, failed })
        if (failed > 0) {
          const failureDetail = outcome.failed
            .map((item) => `${item.udid.slice(0, 6)}: ${item.reason}`)
            .join('；')
          const message = `同步停止 · ${succeeded}/${sessionTargets.length} 台已送出${failureDetail ? ` · ${failureDetail}` : ''}`
          setPhase('error')
          setDetail(message)
          onShowToast(`GPS 同步瞬移部分失敗：${succeeded}/${sessionTargets.length} 台，已停止監看`, 8000)
          terminalNoticeRef.current = message
          await stop(false, true)
          return
        }
      } else {
        await onTeleport(coordinate, sessionTargets[0])
      }
      setLastCoordinate(coordinate)
      setAmbiguous([])
      // If a legacy detector surfaces an ambiguous choice during an active
      // group session, keep the continuous watcher alive after the explicit
      // selection. A standalone one-shot choice retains the old idle result.
      const keepWatching = modeForSession === 'all' && sessionTargets.length > 0
        && sessionRef.current > 0 && !stoppingRef.current
      setPhase(keepWatching ? 'watching' : 'idle')
      setDetail(keepWatching
        ? `監看中 · ${formatCoordinate(coordinate)}`
        : `已瞬移 · ${formatCoordinate(coordinate)}；可重新框選`)
    } catch (error: any) {
      const message = error?.message || '瞬移失敗'
      setPhase('error')
      setDetail(message)
      onShowToast(`GPS 自動瞬移失敗：${message}`, 8000)
    }
  }, [currentTargetUdids, dispatchAll, onShowToast, onTeleport, stop])

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
      <div className="gps-watch-mode gps-watch-target-mode" aria-label="GPS 目標裝置">
        <button
          className={targetMode === 'primary' ? 'selected' : ''}
          disabled={active}
          aria-pressed={targetMode === 'primary'}
          onClick={() => changeTargetMode('primary')}
          title="只瞬移主裝置"
        >主裝置</button>
        <button
          className={targetMode === 'all' ? 'selected' : ''}
          disabled={active || connectedUdids.length < 2}
          aria-pressed={targetMode === 'all'}
          onClick={() => changeTargetMode('all')}
          title="同一座標同步瞬移全部已連線裝置"
        >全部 {connectedUdids.length} 台</button>
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
            {delivery && <em>送 {delivery.ok}/{delivery.total}</em>}
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
