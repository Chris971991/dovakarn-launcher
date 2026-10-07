// The Nexus window's own strip page: state in, the player's buttons out. Nothing else (no Node, no other channels)
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('nexusStrip', {
  onState: callback => ipcRenderer.on('nexus:strip', (_event, value) => callback(value)),
  act: action => ipcRenderer.invoke('nexus:action', String(action)),
  ready: () => ipcRenderer.send('nexus:strip-ready'),
  height: px => ipcRenderer.send('nexus:strip-height', Number(px)),
})
