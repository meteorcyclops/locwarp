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
  const detectorRef = useRef(new CoordinateAutoDetector({
    stabilityFrames: 2,
    distanceMeters: 20,
    roundDecimals: 5,
    minIntervalMs: 900,
    // Vision supplies a confidence score for every parsed coordinate.  Keep
    // automatic teleports conservative; ambiguous/low-confidence OCR stays
    // visible to the user but cannot move the device.
    minConfidence: 0.9,
    requireConfidence: true,
  }))
  const teleportRef = useRef(onTeleport)
  const connectedRef = useRef(isConnected)
  const routeRunningRef = useRef(isRouteRunning)
  const stoppingRef = useRef(false)
  const sessionRef = useRef(0)
  const targetUdidRef = useRef<string | null>(null)
  const ignoreStoppedRef = useRef(false)

  useEffect(() => { teleportRef.current = onTeleport }, [onTeleport])
  useEffect(() => { connectedRef.current = isConnected }, [isConnected])
  useEffect(() => { routeRunningRef.current = isRouteRunning }, [isRouteRunning])

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
        if (result.phase === 'baseline') {
          setPhase('watching')
          setDetail(`監看中 · 已略過目前 ${result.candidates.length} 筆座標`)
          return
        }
        if (result.phase === 'ambiguous') {
          setAmbiguous(result.newCandidates)
          setPhase('ambiguous')
          setDetail(`同時發現 ${result.newCandidates.length} 筆新座標，已暫停`)
          void stop(true).then(() => {
            setPhase('ambiguous')
            setDetail(`同時發現 ${result.newCandidates.length} 筆新座標，請選擇`)
          })
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
        setPhase('idle')
        setDetail(event.reason === 'hotkey' ? '已由快捷鍵停止 GPS 監看' : 'GPS 畫面監看已停止')
      }
    })
  }, [onShowToast, stop])

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
    detectorRef.current.reset()
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

  return (
    <div className={`gps-watch-control phase-${phase}`}>
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
