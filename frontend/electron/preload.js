const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  locatePc: () => ipcRenderer.invoke('locate-pc'),
  getRenderMode: () => ipcRenderer.invoke('get-render-mode'),
  setRenderMode: (mode) => ipcRenderer.invoke('set-render-mode', mode),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),
  getDesktopApiConfig: () => ipcRenderer.sendSync('get-desktop-api-config'),
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
})
