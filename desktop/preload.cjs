const { contextBridge, ipcRenderer } = require('electron');

// API minimale exposée à l'interface web uniquement quand elle tourne dans l'appli de bureau.
contextBridge.exposeInMainWorld('jarvisDesktop', {
  hostname: () => ipcRenderer.invoke('jarvis:hostname'),
  agentConfigured: () => ipcRenderer.invoke('jarvis:agent-configured'),
  connectAgent: (cfg) => ipcRenderer.invoke('jarvis:connect-agent', cfg),
  getAutonomy: () => ipcRenderer.invoke('jarvis:get-autonomy'),
  setAutonomy: (v) => ipcRenderer.invoke('jarvis:set-autonomy', v),
});
