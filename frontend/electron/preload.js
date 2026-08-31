const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  locatePc: () => ipcRenderer.invoke('locate-pc'),
  getRenderMode: () => ipcRenderer.invoke('get-render-mode'),
  setRenderMode: (mode) => ipcRenderer.invoke('set-render-mode', mode),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  getDesktopApiConfig: () => ipcRenderer.sendSync('get-desktop-api-config'),
  getNetworkContext: () => ipcRenderer.invoke('get-network-context'),
  onNetworkContextChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('network-context-changed', listener)
    return () => ipcRenderer.removeListener('network-context-changed', listener)
  },
  gpsWatch: {
    selectRegion: () => ipcRenderer.invoke('gps-watch:select-region'),
    start: (region) => ipcRenderer.invoke('gps-watch:start', region),
    stop: () => ipcRenderer.invoke('gps-watch:stop'),
    status: () => ipcRenderer.invoke('gps-watch:status'),
    updateStatus: (status) => ipcRenderer.invoke('gps-watch:update-status', status),
    showMain: () => ipcRenderer.invoke('gps-watch:show-main'),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('gps-watch:event', listener)
      return () => ipcRenderer.removeListener('gps-watch:event', listener)
    },
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
})
