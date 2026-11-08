// electron/preload.cjs — Secure Context Bridge for EngiDraft 3D Desktop
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engiDraftDesktop', {
  isElectron: true,
  platform: process.platform,
  saveFileNative: (options) => ipcRenderer.invoke('engidraft:save-file', options),
});
