const { app, BrowserWindow, Menu, shell, ipcMain, dialog, screen, globalShortcut } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')
const http = require('http')
const os = require('os')
const crypto = require('crypto')

// Render-mode preference (Issue #24). Win 10 stays on software rendering
// by default — v0.2.121/125 hit a Chromium 124 GPU-sandbox crash on
// 22H2 — but users whose hardware works fine can opt in via Settings
// and restart. Win 11 defaults to hardware acceleration as usual.
const RENDER_MODE_FILE = path.join(app.getPath('userData'), 'render-mode.json')

function readRenderModePref() {
  try {
    const raw = fs.readFileSync(RENDER_MODE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && (parsed.mode === 'hardware' || parsed.mode === 'software')) {
      return parsed.mode
    }
  } catch { /* missing or corrupt — fall through to default */ }
  return null
}

function writeRenderModePref(mode) {
  try {
    fs.mkdirSync(path.dirname(RENDER_MODE_FILE), { recursive: true })
    fs.writeFileSync(RENDER_MODE_FILE, JSON.stringify({ mode }, null, 2), 'utf8')
  } catch (e) {
    console.error('[render-mode] failed to save pref:', e && e.message)
  }
}

if (process.platform === 'win32') {
  const winBuild = parseInt((os.release() || '0.0.0').split('.')[2] || '0', 10)
  const isWin10 = winBuild > 0 && winBuild < 22000
  const saved = readRenderModePref()
  // Effective mode: saved pref wins; otherwise Win 10 → software, Win 11 → hardware.
  const mode = saved || (isWin10 ? 'software' : 'hardware')
  if (mode === 'software') {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('no-sandbox')
    app.commandLine.appendSwitch('in-process-gpu')
  }
}

// Locate-PC over IPC: shells out to PowerShell + System.Device.Location
// (the Windows Location API). This taps Windows' built-in Wi-Fi
// positioning + GPS without needing a Google API key (which Electron's
// navigator.geolocation requires) or any third-party HTTP service.
// Accuracy in urban areas is typically 30-100m; rural ~500m.
const LOCATE_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
  $watcher.Start()
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
    if ($watcher.Status -eq 'Ready' -and -not $watcher.Position.Location.IsUnknown) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
  $loc = $watcher.Position.Location
  if ($loc.IsUnknown) { Write-Output ('NODATA,status=' + $watcher.Status); exit 0 }
  Write-Output ('OK,' + $loc.Latitude + ',' + $loc.Longitude + ',' + $loc.HorizontalAccuracy)
  $watcher.Stop()
} catch {
  Write-Output ('ERROR,' + $_.Exception.Message)
}
`

// Run an HTTPS GET from the Electron main process (no renderer CORS,
// no Content-Security-Policy block) and return the parsed JSON. Used
// by the IP-geolocation fallback chain inside the locate-pc handler.
const httpsGetJson = (url) => {
  return new Promise((resolve) => {
    const https = require('https')
    const req = https.get(url, { headers: { 'User-Agent': 'LocWarp-Electron' }, timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return resolve(null)
      }
      let chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch {} ; resolve(null) })
  })
}

const ipFallback = async () => {
  // ipwho.is — no key, no signup, HTTPS, returns latitude/longitude in JSON.
  const a = await httpsGetJson('https://ipwho.is/')
  if (a && typeof a.latitude === 'number' && typeof a.longitude === 'number') {
    return { ok: true, lat: a.latitude, lng: a.longitude, accuracy: 5000, via: 'ipwho.is' }
  }
  // ipapi.co — backup, also no key.
  const b = await httpsGetJson('https://ipapi.co/json/')
  if (b && b.latitude != null && b.longitude != null) {
    const lat = parseFloat(b.latitude); const lng = parseFloat(b.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'ipapi.co' }
    }
  }
  // freeipapi.com — last resort.
  const c = await httpsGetJson('https://freeipapi.com/api/json/')
  if (c && c.latitude != null && c.longitude != null) {
    const lat = parseFloat(c.latitude); const lng = parseFloat(c.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'freeipapi.com' }
    }
  }
  return null
}

const tryWindowsLocation = () => {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LOCATE_PS_SCRIPT],
      { windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => console.error('[locate-pc] stderr:', d.toString('utf8')))
    child.on('error', (e) => finish({ ok: false, code: 'SPAWN_FAILED', message: e.message }))
    child.on('exit', () => {
      const trimmed = out.trim()
      if (trimmed.startsWith('OK,')) {
        const parts = trimmed.split(',')
        const lat = parseFloat(parts[1])
        const lng = parseFloat(parts[2])
        const acc = parseFloat(parts[3])
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return finish({ ok: true, lat, lng, accuracy: Number.isFinite(acc) ? acc : 100 })
        }
      }
      if (trimmed === 'DENIED') return finish({ ok: false, code: 'DENIED', message: 'Windows Location service is off or app access denied' })
      if (trimmed.startsWith('NODATA')) return finish({ ok: false, code: 'NODATA', message: trimmed.slice(0, 200) })
      if (trimmed.startsWith('ERROR,')) return finish({ ok: false, code: 'ERROR', message: trimmed.slice(6, 200) })
      finish({ ok: false, code: 'UNKNOWN', message: trimmed.slice(0, 200) || 'no PowerShell output' })
    })
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', message: 'PowerShell timed out after 18s' })
    }, 18000)
  })
}

ipcMain.handle('get-render-mode', () => {
  // Surface the current saved mode + whether the OS is the one we
  // originally bypassed (Win 10), so the Settings panel can decide
  // whether to highlight this toggle as relevant.
  let isWin10 = false
  if (process.platform === 'win32') {
    const winBuild = parseInt((os.release() || '0.0.0').split('.')[2] || '0', 10)
    isWin10 = winBuild > 0 && winBuild < 22000
  }
  const saved = readRenderModePref()
  // If no pref exists and we're not on Win 10, the effective mode is
  // hardware (current default for Win 11). On Win 10 with no pref, we
  // already prompted at startup, so this branch shouldn't normally hit.
  const effective = saved || (isWin10 ? 'software' : 'hardware')
  return { mode: effective, saved, isWin10 }
})

ipcMain.handle('set-render-mode', (_e, mode) => {
  if (mode !== 'hardware' && mode !== 'software') return { ok: false }
  writeRenderModePref(mode)
  return { ok: true }
})

ipcMain.handle('relaunch-app', () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('locate-pc', async () => {
  const win = await tryWindowsLocation()
  if (win.ok) return { ...win, via: 'windows' }
  if (win.code === 'DENIED') return win
  // Windows Location returned NODATA / TIMEOUT / ERROR / UNKNOWN. Fall
  // back to IP geolocation from the main process so the request is
  // free of any renderer CORS / CSP restrictions.
  const ip = await ipFallback()
  if (ip) return ip
  // Both layers failed — surface the original Windows error so the
  // dialog can show the user something diagnostic instead of just
  // "everything failed".
  return {
    ok: false,
    code: 'ALL_FAILED',
    message: `Windows Location: ${win.code}${win.message ? ' (' + win.message + ')' : ''} | IP fallback: all 3 services unreachable`,
  }
})

// Keep the menu visually hidden, but restore native edit roles so
// Windows/Linux keyboard shortcuts like Ctrl+C / Ctrl+V still work inside
// inputs after packaging.
Menu.setApplicationMenu(Menu.buildFromTemplate([
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  },
]))

let mainWindow
let backendProc = null
const BACKEND_PORT = 8777
const desktopApiToken = crypto.randomBytes(32).toString('hex')
let backendStopPromise = null
let quitAfterBackendStops = false
let gpsWatchSelectionWindow = null
let gpsWatchSelectionFinish = null
let gpsWatchBorderWindow = null
let gpsWatchProc = null
let gpsWatchRegion = null
let gpsWatchState = 'idle'
let gpsWatchStdoutBuffer = ''
let gpsWatchStopTimer = null
let gpsWatchForceKillTimer = null
let gpsWatchStartupTimer = null

function sendGpsWatchEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('gps-watch:event', payload)
  }
}

function resolveGpsWatchHelper() {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'gps-watch', 'locwarp-ocr-helper'),
        path.join(process.resourcesPath, 'locwarp-ocr-helper'),
      ]
    : [
        path.join(__dirname, '../../dist-macos/locwarp-ocr-helper'),
        path.join(__dirname, '../../macos/build/locwarp-ocr-helper'),
        path.join(__dirname, '../../macos/locwarp-ocr-helper/.build/release/locwarp-ocr-helper'),
      ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function closeGpsWatchBorder() {
  if (gpsWatchBorderWindow && !gpsWatchBorderWindow.isDestroyed()) gpsWatchBorderWindow.close()
  gpsWatchBorderWindow = null
}

function showGpsWatchBorder(region) {
  closeGpsWatchBorder()
  const bounds = region?.displayBounds
  if (!bounds) return
  const width = Math.max(48, Math.round(region.width))
  const height = Math.max(32, Math.round(region.height))
  gpsWatchBorderWindow = new BrowserWindow({
    x: Math.round(bounds.x + region.x),
    y: Math.round(bounds.y + region.y),
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  gpsWatchBorderWindow.setAlwaysOnTop(true, 'floating')
  gpsWatchBorderWindow.setIgnoreMouseEvents(true)
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
    body{box-sizing:border-box;border:2px solid #4ecdc4;border-radius:8px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2),0 0 14px rgba(78,205,196,.55)}
    span{position:absolute;top:5px;left:7px;padding:3px 7px;border-radius:6px;background:rgba(8,18,25,.88);color:#dffefa;font:600 10px -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap}
  </style><span>LocWarp GPS 掃描中 · Esc 停止</span>`
  gpsWatchBorderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  gpsWatchBorderWindow.showInactive()
}

function clearGpsWatchProcessState() {
  if (gpsWatchStopTimer) clearTimeout(gpsWatchStopTimer)
  if (gpsWatchForceKillTimer) clearTimeout(gpsWatchForceKillTimer)
  if (gpsWatchStartupTimer) clearTimeout(gpsWatchStartupTimer)
  gpsWatchStopTimer = null
  gpsWatchForceKillTimer = null
  gpsWatchStartupTimer = null
  gpsWatchProc = null
  gpsWatchStdoutBuffer = ''
  gpsWatchState = 'idle'
  gpsWatchRegion = null
  closeGpsWatchBorder()
  globalShortcut.unregister('Alt+Shift+G')
  globalShortcut.unregister('Escape')
}

function writeGpsWatchCommand(child, command) {
  if (
    !child ||
    child !== gpsWatchProc ||
    child.killed ||
    !child.stdin ||
    child.stdin.destroyed ||
    !child.stdin.writable
  ) return false
  try {
    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) console.error('[gps-watch-helper] stdin write failed:', error.message)
    })
    return true
  } catch (error) {
    console.error('[gps-watch-helper] stdin write failed:', error.message)
    return false
  }
}

async function stopGpsWatch(reason = 'user') {
  if (gpsWatchSelectionFinish) {
    finishGpsWatchSelection({ ok: false, code: 'cancelled_by_stop', reason })
  }
  const child = gpsWatchProc
  if (!child) {
    clearGpsWatchProcessState()
    return { ok: true, state: 'idle' }
  }
  if (gpsWatchState === 'stopping') {
    await waitForChildExit(child, 3500)
    return { ok: true, state: child === gpsWatchProc ? 'stopping' : 'idle' }
  }
  gpsWatchState = 'stopping'
  writeGpsWatchCommand(child, { command: 'shutdown' })
  gpsWatchStopTimer = setTimeout(() => {
    try { child.kill('SIGTERM') } catch {}
  }, 1200)
  gpsWatchForceKillTimer = setTimeout(() => {
    if (child === gpsWatchProc) {
      try { child.kill('SIGKILL') } catch {}
    }
  }, 3000)
  closeGpsWatchBorder()
  sendGpsWatchEvent({ event: 'stopping', reason })
  const exited = await waitForChildExit(child, 3500)
  if (!exited && child === gpsWatchProc) {
    try { child.kill('SIGKILL') } catch {}
    await waitForChildExit(child, 1500)
  }
  if (child === gpsWatchProc) {
    clearGpsWatchProcessState()
    sendGpsWatchEvent({ event: 'stopped', reason: 'forced_shutdown' })
  }
  return { ok: true, state: 'idle' }
}

function handleGpsWatchLine(line, child) {
  if (!line.trim()) return
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    sendGpsWatchEvent({ event: 'error', code: 'invalid_helper_output', message: line.slice(0, 240) })
    return
  }
  if (child !== gpsWatchProc) return
  if (payload.event === 'ready') {
    if (gpsWatchState !== 'starting') return
    const region = gpsWatchRegion
    if (!region) return
    if (!writeGpsWatchCommand(child, {
      command: 'start',
      displayID: region.displayId,
      roi: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        units: 'points',
        scale: region.scaleFactor,
      },
      fps: 5,
      recognitionLevel: 'accurate',
    })) {
      gpsWatchState = 'error'
      sendGpsWatchEvent({ event: 'error', code: 'helper_stdin_closed', message: 'GPS OCR helper 已提前結束' })
    }
  } else if (payload.event === 'started') {
    if (gpsWatchState !== 'starting') return
    if (gpsWatchStartupTimer) clearTimeout(gpsWatchStartupTimer)
    gpsWatchStartupTimer = null
    gpsWatchState = 'watching'
    showGpsWatchBorder(gpsWatchRegion)
  } else if (payload.event === 'error') {
    gpsWatchState = payload.code === 'permission_denied' ? 'permission_denied' : 'error'
  }
  sendGpsWatchEvent(payload)
}

function startGpsWatch(region) {
  if (process.platform !== 'darwin') return { ok: false, code: 'unsupported_platform' }
  if (gpsWatchProc) return { ok: false, code: 'already_running' }
  if (!region || !Number.isFinite(region.displayId) || region.width < 32 || region.height < 24) {
    return { ok: false, code: 'invalid_region' }
  }
  const helper = resolveGpsWatchHelper()
  if (!fs.existsSync(helper)) return { ok: false, code: 'helper_missing', helper }

  gpsWatchRegion = region
  gpsWatchState = 'starting'
  gpsWatchStdoutBuffer = ''
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  gpsWatchProc = child

  gpsWatchStartupTimer = setTimeout(() => {
    if (child !== gpsWatchProc || gpsWatchState !== 'starting') return
    gpsWatchState = 'error'
    sendGpsWatchEvent({
      event: 'error',
      code: 'startup_timeout',
      message: 'GPS OCR helper 啟動逾時，請檢查螢幕擷取權限後重試',
    })
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
    void stopGpsWatch('startup_timeout')
  }, 30000)

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    if (child !== gpsWatchProc) return
    gpsWatchStdoutBuffer += chunk
    let newline
    while ((newline = gpsWatchStdoutBuffer.indexOf('\n')) >= 0) {
      const line = gpsWatchStdoutBuffer.slice(0, newline)
      gpsWatchStdoutBuffer = gpsWatchStdoutBuffer.slice(newline + 1)
      handleGpsWatchLine(line, child)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    console.error('[gps-watch-helper]', String(chunk).trim())
  })
  child.stdin.on('error', (error) => {
    if (child !== gpsWatchProc || gpsWatchState === 'stopping') return
    gpsWatchState = 'error'
    sendGpsWatchEvent({ event: 'error', code: 'helper_stdin_error', message: error.message })
  })
  child.on('error', (error) => {
    if (child !== gpsWatchProc) return
    sendGpsWatchEvent({ event: 'error', code: 'helper_spawn_failed', message: error.message })
    clearGpsWatchProcessState()
  })
  child.on('exit', (code, signal) => {
    if (child !== gpsWatchProc) return
    const wasStopping = gpsWatchState === 'stopping'
    clearGpsWatchProcessState()
    sendGpsWatchEvent({
      event: 'stopped',
      reason: wasStopping ? 'user' : 'helper_exit',
      code,
      signal,
    })
  })

  globalShortcut.unregister('Alt+Shift+G')
  globalShortcut.register('Alt+Shift+G', () => {
    const stopPromise = stopGpsWatch('hotkey')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
    void stopPromise
  })
  globalShortcut.unregister('Escape')
  const escapeRegistered = globalShortcut.register('Escape', () => {
    const stopPromise = stopGpsWatch('escape')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
    void stopPromise
  })
  if (!escapeRegistered) {
    sendGpsWatchEvent({
      event: 'warning',
      code: 'escape_shortcut_unavailable',
      message: 'Esc 快捷鍵目前無法註冊；可按停止按鈕或使用 ⌥⇧G 離開 GPS 掃描',
    })
  }
  return { ok: true, state: 'starting', region }
}

function finishGpsWatchSelection(result) {
  const finish = gpsWatchSelectionFinish
  gpsWatchSelectionFinish = null
  if (gpsWatchSelectionWindow && !gpsWatchSelectionWindow.isDestroyed()) {
    gpsWatchSelectionWindow.close()
  }
  gpsWatchSelectionWindow = null
  if (!result?.ok && result?.code !== 'app_quit' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
  if (finish) finish(result)
}

ipcMain.on('gps-watch:overlay-complete', (event, rect) => {
  if (!gpsWatchSelectionWindow || event.sender !== gpsWatchSelectionWindow.webContents) return
  const x = Math.max(0, Math.round(Number(rect?.x) || 0))
  const y = Math.max(0, Math.round(Number(rect?.y) || 0))
  const width = Math.round(Number(rect?.width) || 0)
  const height = Math.round(Number(rect?.height) || 0)
  if (width < 32 || height < 24) return
  const display = screen.getDisplayMatching(gpsWatchSelectionWindow.getBounds())
  finishGpsWatchSelection({
    ok: true,
    region: {
      displayId: display.id,
      displayBounds: display.bounds,
      scaleFactor: display.scaleFactor,
      x,
      y,
      width: Math.min(width, display.bounds.width - x),
      height: Math.min(height, display.bounds.height - y),
    },
  })
})

ipcMain.on('gps-watch:overlay-cancel', (event) => {
  if (!gpsWatchSelectionWindow || event.sender !== gpsWatchSelectionWindow.webContents) return
  finishGpsWatchSelection({ ok: false, code: 'cancelled' })
})

ipcMain.handle('gps-watch:select-region', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, code: 'unsupported_platform' }
  }
  if (gpsWatchSelectionFinish) {
    return { ok: false, code: 'selection_in_progress' }
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()

  return new Promise((resolve) => {
    gpsWatchSelectionFinish = resolve
    gpsWatchSelectionWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'gps-watch-overlay-preload.js'),
      },
    })
    gpsWatchSelectionWindow.setAlwaysOnTop(true, 'screen-saver')
    gpsWatchSelectionWindow.loadFile(path.join(__dirname, 'gps-watch-overlay.html')).catch((error) => {
      finishGpsWatchSelection({ ok: false, code: 'overlay_load_failed', message: error.message })
    })
    gpsWatchSelectionWindow.once('ready-to-show', () => {
      gpsWatchSelectionWindow?.show()
      gpsWatchSelectionWindow?.focus()
    })
    gpsWatchSelectionWindow.on('closed', () => {
      gpsWatchSelectionWindow = null
      if (gpsWatchSelectionFinish) finishGpsWatchSelection({ ok: false, code: 'cancelled' })
    })
  })
})

ipcMain.handle('gps-watch:start', (_event, region) => startGpsWatch(region))
ipcMain.handle('gps-watch:stop', () => stopGpsWatch('user'))
ipcMain.handle('gps-watch:status', () => ({
  state: gpsWatchState,
  region: gpsWatchRegion,
  supported: process.platform === 'darwin',
}))
ipcMain.handle('gps-watch:show-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
  return { ok: true }
})

ipcMain.on('get-desktop-api-config', (event) => {
  event.returnValue = {
    baseUrl: `http://127.0.0.1:${BACKEND_PORT}`,
    token: desktopApiToken,
  }
})

const backendRuntimeDir = () => path.join(app.getPath('userData'), 'backend-runtime')
const backendPidFile = () => path.join(backendRuntimeDir(), 'backend.pid')

const ensureBackendRuntimeDir = () => {
  fs.mkdirSync(backendRuntimeDir(), { recursive: true })
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        error.detail = (stderr || stdout || error.message || '').trim()
        return reject(error)
      }
      resolve((stdout || '').trim())
    })
  })
}

async function listenerPid() {
  if (process.platform !== 'darwin') return null
  try {
    const raw = await execFileText('lsof', ['-nP', `-iTCP:${BACKEND_PORT}`, '-sTCP:LISTEN', '-t'])
    const pid = Number(String(raw).split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 1 ? pid : null
  } catch {
    return null
  }
}

async function stopStaleMacBackend(exe) {
  const pid = await listenerPid()
  if (!pid) return

  const [command, uidText] = await Promise.all([
    execFileText('ps', ['-p', String(pid), '-o', 'command=']),
    execFileText('ps', ['-p', String(pid), '-o', 'uid=']),
  ])
  const resolvedExe = fs.realpathSync(exe)
  const resolvedCommand = String(command).trim().split(/\s+/)[0]
  let commandExe = resolvedCommand
  try { commandExe = fs.realpathSync(resolvedCommand) } catch {}
  if (commandExe !== resolvedExe) {
    throw new Error(`port ${BACKEND_PORT} is used by an unrelated process (pid ${pid})`)
  }

  const ownerUid = Number(String(uidText).trim())
  if (ownerUid === process.getuid()) {
    process.kill(pid, 'SIGTERM')
  } else if (ownerUid !== 0) {
    throw new Error(`backend pid ${pid} belongs to another user`)
  } else {
    // One-time migration path for releases that launched the entire backend as
    // root.  The PID and executable were validated above before requesting
    // elevation; arbitrary listeners on the port are never terminated.
    const commandToRun = `kill -TERM ${pid}`
    const script = `do shell script ${JSON.stringify(commandToRun)} with administrator privileges`
    await execFileText('osascript', ['-e', script])
  }
  for (let i = 0; i < 20 && await isBackendReachable(200); i++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (await isBackendReachable(200)) {
    throw new Error(`previous backend pid ${pid} did not release port ${BACKEND_PORT}`)
  }
}

function resolveBackendExe() {
  // In a packaged build, extraResources places files under process.resourcesPath.
  // Prefer the platform-native filename, but fall back to the alternate name
  // so a stale/mismatched package fails more gracefully.
  if (!app.isPackaged) return null

  const backendDir = path.join(process.resourcesPath, 'backend')
  const candidates = process.platform === 'win32'
    ? ['locwarp-backend.exe', 'locwarp-backend']
    : ['locwarp-backend', 'locwarp-backend.exe']

  for (const name of candidates) {
    const candidate = path.join(backendDir, name)
    if (fs.existsSync(candidate)) return candidate
  }

  console.error('[electron] backend binary not found in', backendDir, 'candidates:', candidates)
  return null
}

// PyInstaller bundles are sometimes quarantined by Windows antivirus after a
// successful install. Keep the macOS runtime hardening above, but provide the
// actionable upstream v0.2.193 recovery guidance on Windows when the packaged
// backend disappears.
function showBackendMissingDialog(exe, detail) {
  const zh = (app.getLocale() || '').toLowerCase().startsWith('zh')
  const msg = zh
    ? {
        title: 'LocWarp 無法啟動',
        message: '找不到背景服務 (locwarp-backend.exe)',
        detail:
          '這個檔案通常是被防毒軟體隔離或刪除。\n\n' +
          '請在 Windows 安全性或第三方防毒軟體中還原 LocWarp，將 ' +
          'C:\\Program Files\\LocWarp 加入排除項目，再重新安裝。\n\n' +
          `預期路徑：\n${exe}` +
          (detail ? `\n\n${detail}` : ''),
        buttons: ['開啟安裝資料夾', '關閉'],
      }
    : {
        title: 'LocWarp cannot start',
        message: 'Backend service not found (locwarp-backend.exe)',
        detail:
          'Antivirus software may have quarantined or removed this file.\n\n' +
          'Restore LocWarp in Windows Security or your antivirus product, add ' +
          'C:\\Program Files\\LocWarp as an exclusion, then reinstall.\n\n' +
          `Expected path:\n${exe}` +
          (detail ? `\n\n${detail}` : ''),
        buttons: ['Open install folder', 'Close'],
      }

  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: msg.title,
    message: msg.message,
    detail: msg.detail,
    buttons: msg.buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice === 0) {
    const dir = fs.existsSync(path.dirname(exe)) ? path.dirname(exe) : process.resourcesPath
    shell.openPath(dir)
  }
  app.quit()
}

async function isBackendReachable(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/healthz`, (res) => {
      res.destroy()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => {
      try { req.destroy() } catch {}
      resolve(false)
    })
  })
}

async function backendVersion(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/healthz`, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          resolve(typeof parsed.version === 'string' ? parsed.version : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => {
      try { req.destroy() } catch {}
      resolve(null)
    })
  })
}

async function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) {
    console.error('[electron] backend spawn skipped: executable not found')
    if (process.platform === 'win32' && app.isPackaged) {
      showBackendMissingDialog(
        path.join(process.resourcesPath, 'backend', 'locwarp-backend.exe'),
        null,
      )
    }
    return
  }
  console.log('[electron] spawning backend:', exe)

  if (backendProc && backendProc.exitCode === null && await isBackendReachable()) {
    return
  }

  if (await isBackendReachable()) {
    const runningVersion = await backendVersion()
    console.log('[electron] replacing backend from an earlier session:', runningVersion || 'unknown')
    if (process.platform !== 'darwin') {
      throw new Error(`port ${BACKEND_PORT} is already in use`)
    }
    await stopStaleMacBackend(exe)
  }

  ensureBackendRuntimeDir()
  backendProc = spawn(exe, [], {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      LOCWARP_DESKTOP_TOKEN: desktopApiToken,
      LOCWARP_API_HOST: '0.0.0.0',
    },
  })
  fs.writeFileSync(backendPidFile(), String(backendProc.pid), { encoding: 'utf8', mode: 0o600 })
  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  const spawnedProc = backendProc
  spawnedProc.on('error', (error) => {
    console.error('[electron] backend process error:', error.message)
    if (process.platform === 'win32') {
      showBackendMissingDialog(exe, error.message)
    }
  })
  spawnedProc.on('exit', (code, signal) => {
    console.log('[electron] backend exited', { code, signal })
    if (backendProc === spawnedProc) backendProc = null
    try {
      if (fs.readFileSync(backendPidFile(), 'utf8').trim() === String(spawnedProc.pid)) {
        fs.unlinkSync(backendPidFile())
      }
    } catch {}
  })
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopBackend() {
  if (backendStopPromise) return backendStopPromise
  const child = backendProc
  if (!child) return
  backendStopPromise = (async () => {
    try { child.kill('SIGTERM') } catch {}
    const exited = await waitForChildExit(child, 5000)
    if (!exited) {
      console.warn('[electron] backend did not stop after SIGTERM; forcing shutdown')
      try { child.kill('SIGKILL') } catch {}
      await waitForChildExit(child, 2000)
    }
    if (backendProc === child) backendProc = null
  })().finally(() => { backendStopPromise = null })
  return backendStopPromise
}

ipcMain.handle('restart-backend', async () => {
  const exe = resolveBackendExe()
  if (!exe) throw new Error('backend executable not found')

  await stopBackend()
  await startBackend()

  await waitForBackend(30000)
  return { ok: true }
})

function waitForBackend(timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/healthz`, (res) => {
        res.destroy()
        if (res.statusCode === 200) resolve()
        else if (Date.now() - started > timeoutMs) reject(new Error('backend timeout'))
        else setTimeout(tick, 500)
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('backend timeout'))
        setTimeout(tick, 500)
      })
    }
    tick()
  })
}

async function createWindow() {
  // OSM tile policy (https://operations.osmfoundation.org/policies/tiles/)
  // requires an identifying User-Agent; Electron's default Chrome UA is
  // blocked with HTTP 418. Rewrite the UA on requests to the OSM tile
  // endpoints so we can use the 'Standard' (Mapnik) style for free.
  try {
    const { session } = require('electron')
    const OSM_HOSTS = [
      'tile.openstreetmap.org',
      'a.tile.openstreetmap.org',
      'b.tile.openstreetmap.org',
      'c.tile.openstreetmap.org',
      'tile.openstreetmap.fr',
      'a.tile.openstreetmap.fr',
      'b.tile.openstreetmap.fr',
      'c.tile.openstreetmap.fr',
    ]
    session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
      try {
        const u = new URL(details.url)
        if (OSM_HOSTS.includes(u.hostname)) {
          details.requestHeaders['User-Agent'] =
            'LocWarp-koxuan/0.2.193-kx.7 (+https://github.com/meteorcyclops/locwarp)'
          details.requestHeaders['Referer'] = 'https://github.com/meteorcyclops/locwarp'
        }
      } catch {}
      cb({ requestHeaders: details.requestHeaders })
    })
  } catch (e) { console.error('[electron] UA hook failed:', e) }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LocWarp',
    autoHideMenuBar: true,
    // Match the app's dark theme so the initial frame isn't white while
    // the renderer attaches — previously caused a jarring white flash.
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Default Chromium blocks AudioContext output until a user gesture
      // happens on the page; that breaks the route-completion alert
      // sound when a long loop finishes while the user is away from the
      // window. LocWarp is a desktop tool (not a random webpage), so
      // disable the gesture gate entirely.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  // Show the window once the first frame is painted. Combined with
  // backgroundColor above, this eliminates the blank/white boot state.
  mainWindow.once('ready-to-show', () => { mainWindow.show() })
  const createdWindow = mainWindow
  createdWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null
    void stopGpsWatch('main_window_closed')
  })

  // Open target="_blank" / external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  const isDev = process.argv.includes('--dev') || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // Spawn the backend in parallel and load the UI immediately. On macOS,
    // only the backend is elevated so the renderer keeps the normal user
    // session clipboard / window permissions.
    try {
      await startBackend()
    } catch (e) {
      dialog.showErrorBox('LocWarp backend failed to start', String(e.message || e))
    }
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void stopBackend()
    app.quit()
  }
})
app.on('before-quit', (event) => {
  if (gpsWatchProc) {
    try { gpsWatchProc.kill('SIGKILL') } catch {}
    clearGpsWatchProcessState()
  }
  finishGpsWatchSelection({ ok: false, code: 'app_quit' })
  if (quitAfterBackendStops || !backendProc) return
  event.preventDefault()
  quitAfterBackendStops = true
  void stopBackend().finally(() => app.exit(0))
})
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    void createWindow()
  }
})
