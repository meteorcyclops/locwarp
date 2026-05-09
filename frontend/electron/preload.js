const { contextBridge, ipcRenderer, clipboard } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  locatePc: () => ipcRenderer.invoke('locate-pc'),
  getRenderMode: () => ipcRenderer.invoke('get-render-mode'),
  setRenderMode: (mode) => ipcRenderer.invoke('set-render-mode', mode),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
})
