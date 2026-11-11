const { contextBridge, ipcRenderer } = require('electron');

// API minimale exposée à l'interface web uniquement quand elle tourne dans l'appli de bureau.
contextBridge.exposeInMainWorld('jarvisDesktop', {
  hostname: () => ipcRenderer.invoke('jarvis:hostname'),
  agentConfigured: () => ipcRenderer.invoke('jarvis:agent-configured'),
  connectAgent: (cfg) => ipcRenderer.invoke('jarvis:connect-agent', cfg),
  getAutonomy: () => ipcRenderer.invoke('jarvis:get-autonomy'),
  setAutonomy: (v) => ipcRenderer.invoke('jarvis:set-autonomy', v),
  appInfo: () => ipcRenderer.invoke('jarvis:app-info'),
  // Mises à jour à distance (version signée, téléchargée puis installée au redémarrage)
  update: {
    state: () => ipcRenderer.invoke('jarvis:update-state'),
    check: () => ipcRenderer.invoke('jarvis:update-check'),
    install: () => ipcRenderer.invoke('jarvis:update-install'),
    prefs: () => ipcRenderer.invoke('jarvis:update-prefs'),
    setPrefs: (p) => ipcRenderer.invoke('jarvis:update-set-prefs', p),
    onState: (cb) => {
      const h = (_e, s) => cb(s);
      ipcRenderer.on('jarvis:update-state', h);
      return () => ipcRenderer.removeListener('jarvis:update-state', h);
    },
  },
});
