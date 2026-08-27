const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gpsWatchOverlay', {
  complete: (rect) => ipcRenderer.send('gps-watch:overlay-complete', rect),
  cancel: () => ipcRenderer.send('gps-watch:overlay-cancel'),
})
