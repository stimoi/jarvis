// Appli de bureau JARVIS : fenêtre + icône de zone de notification (barre des tâches) + agent PC.
//  - mode « remote » (défaut, appli installée) : charge le site (jarvis.avenox.fr) et lance l'agent qui s'y connecte ;
//  - mode « local » (développement : `npm run desktop:local`) : lance aussi le serveur Node sur ce PC.
// La fenêtre se masque au lieu de se fermer : l'écoute « Jarvis » continue en arrière-plan.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const LOCAL = process.env.JARVIS_MODE === 'local' || process.argv.includes('--local');

function readAppConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8')); } catch { return {}; }
}
const PORT = Number(process.env.PORT || 8787);
const SERVER_URL = (LOCAL ? `http://127.0.0.1:${PORT}` : process.env.JARVIS_SERVER || readAppConfig().serverUrl || 'https://jarvis.avenox.fr').replace(/\/+$/, '');
const APP_URL = `${SERVER_URL}/chat/`;
const ORIGIN = new URL(SERVER_URL).origin;

// Données (config de l'agent, journal d'audit, interrupteur PAUSE) : dossier du projet en développement, profil utilisateur une fois installée.
const DATA_DIR = process.env.JARVIS_DATA_DIR || (app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'data'));
const AGENT_CONFIG = path.join(DATA_DIR, 'agent.json');
const PAUSE_FILE = path.join(DATA_DIR, 'PAUSE');
const ICON = path.join(ROOT, 'web', 'icons', 'icon-192.png');
const PACKED_PIPER = path.join(process.resourcesPath || '', 'piper');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let quitting = false;
const children = {};

// L'agent n'utilise que des API Node basiques : il tourne avec le Node intégré d'Electron (aucune installation requise).
// Le serveur local (mode développement) a besoin de node:sqlite (Node >= 22.5) : Node du système.
function startChild(name, script) {
  const isAgent = name === 'agent';
  const env = { ...process.env, JARVIS_DATA_DIR: DATA_DIR, HOST: process.env.HOST || '0.0.0.0' };
  if (isAgent) {
    env.ELECTRON_RUN_AS_NODE = '1';
    if (fs.existsSync(PACKED_PIPER)) env.JARVIS_PIPER_DIR = PACKED_PIPER;
  }
  const child = spawn(isAgent ? process.execPath : process.env.JARVIS_NODE || 'node', [path.join(ROOT, script)], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  children[name] = child;
  child.on('error', (e) => {
    if (!isAgent && !quitting) dialog.showErrorBox('JARVIS', `Impossible de lancer Node.js (${e.message}). Installez Node 22+ (https://nodejs.org).`);
  });
  child.on('exit', () => {
    if (children[name] === child && !quitting) setTimeout(() => startChild(name, script), 2000);
  });
}

function waitForServer(retries = 60) {
  return new Promise((resolve, reject) => {
    const probe = () =>
      http.get(`${SERVER_URL}/api/health`, (res) => { res.resume(); res.statusCode === 200 ? resolve() : retry(); }).on('error', retry);
    const retry = () => (--retries <= 0 ? reject(new Error('Le serveur JARVIS ne répond pas')) : setTimeout(probe, 500));
    probe();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 380, minHeight: 560,
    backgroundColor: '#010812', title: 'JARVIS', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.loadURL(APP_URL);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    if (new URL(url).origin !== ORIGIN) { e.preventDefault(); shell.openExternal(url); }
  });
  // Serveur injoignable (hors-ligne, tunnel coupé…) : page d'attente avec nouvelle tentative automatique.
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (!isMain || code === -3) return;
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL } });
  });
  let warned = false;
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!warned) { warned = true; tray?.displayBalloon?.({ title: 'JARVIS', content: 'JARVIS reste actif dans la zone de notification. Clic droit sur l’icône pour quitter.', iconType: 'info' }); }
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

const isPaused = () => fs.existsSync(PAUSE_FILE);

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.setToolTip('JARVIS — à l’écoute');
  const refresh = () =>
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Ouvrir JARVIS', click: showWindow },
      { type: 'separator' },
      {
        label: 'Suspendre le contrôle du PC', type: 'checkbox', checked: isPaused(),
        click: (item) => { item.checked ? fs.writeFileSync(PAUSE_FILE, '') : fs.rmSync(PAUSE_FILE, { force: true }); refresh(); },
      },
      {
        label: 'Lancer au démarrage de Windows', type: 'checkbox', checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: 'Quitter JARVIS', click: () => { quitting = true; app.quit(); } },
    ]));
  refresh();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

ipcMain.handle('jarvis:hostname', () => os.hostname());
ipcMain.handle('jarvis:agent-configured', () => { try { return !!JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8')).token; } catch { return false; } });
ipcMain.handle('jarvis:connect-agent', (_e, cfg) => {
  if (!cfg?.server || !cfg?.token) throw new Error('Configuration invalide');
  if (new URL(cfg.server).origin !== ORIGIN) throw new Error('Serveur inattendu');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8')); } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify({ autonomy: 'balanced', ...prev, ...cfg }, null, 2), { mode: 0o600 });
  children.agent?.kill(); // redémarré automatiquement avec la nouvelle configuration
  return true;
});
ipcMain.handle('jarvis:get-autonomy', () => { try { return JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8')).autonomy || 'balanced'; } catch { return 'balanced'; } });
ipcMain.handle('jarvis:set-autonomy', (_e, v) => {
  if (!['cautious', 'balanced', 'trusting'].includes(v)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(AGENT_CONFIG, 'utf8'));
    cfg.autonomy = v;
    fs.writeFileSync(AGENT_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
});

app.whenReady().then(async () => {
  // DNS sécurisé (DoH) avec repli sur le DNS du système : évite qu'un routeur qui met en cache une mauvaise réponse bloque le site.
  try {
    app.configureHostResolver({
      enableBuiltInResolver: true,
      secureDnsMode: 'automatic',
      secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'],
    });
  } catch {}

  // Micro autorisé uniquement pour le site JARVIS.
  const ok = (wc) => (wc?.getURL?.() || '').startsWith(ORIGIN);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && ok(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && ok(wc));

  // Première exécution de l'appli installée : démarrage automatique avec Windows (modifiable dans le menu de l'icône).
  const flag = path.join(DATA_DIR, '.first-run');
  if (app.isPackaged && !fs.existsSync(flag)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(flag, new Date().toISOString());
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  if (LOCAL) startChild('server', 'server/index.js');
  setTimeout(() => startChild('agent', 'agent/index.js'), LOCAL ? 1200 : 0);
  buildTray();
  if (LOCAL) {
    try { await waitForServer(); } catch (e) { dialog.showErrorBox('JARVIS', e.message); quitting = true; return app.quit(); }
  }
  // Démarrage silencieux au lancement de Windows (--hidden) : on reste dans la zone de notification.
  // Le micro doit rester actif en arrière-plan : la fenêtre est créée même si elle reste masquée.
  createWindow();
  if (process.argv.includes('--hidden')) win.hide();
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; Object.values(children).forEach((c) => c.kill()); });
app.on('window-all-closed', () => {}); // reste actif dans la zone de notification
