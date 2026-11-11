// Appli de bureau JARVIS : fenêtre + icône de zone de notification (barre des tâches) + agent PC + mises à jour à distance.
//  - mode « remote » (défaut, appli installée) : charge le site (jarvis.avenox.fr) et lance l'agent qui s'y connecte ;
//  - mode « local » (développement : `npm run desktop:local`) : lance aussi le serveur Node sur ce PC.
// La fenêtre se masque au lieu de se fermer : l'écoute « Jarvis » continue en arrière-plan.
// Ce fichier est lancé par boot.cjs (qui choisit entre le code livré et un code plus récent téléchargé).
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, session, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createUpdater } = require('./updater.cjs');

const BOOT = global.__jarvis || null; // fourni par boot.cjs (absent en développement)
const ROOT = BOOT?.root || path.resolve(__dirname, '..');
const LOCAL = process.env.JARVIS_MODE === 'local' || process.argv.includes('--local');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const APP_VERSION = BOOT?.version || readJson(path.join(ROOT, 'package.json'))?.version || '0.0.0';
const APP_CONFIG = readJson(path.join(__dirname, 'app-config.json')) || {};

const PORT = Number(process.env.PORT || 8787);
const SERVER_URL = (LOCAL ? `http://127.0.0.1:${PORT}` : process.env.JARVIS_SERVER || APP_CONFIG.serverUrl || 'https://jarvis.avenox.fr').replace(/\/+$/, '');
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

// ---------------------------------------------------------------- mises à jour
const LOG_FILE = BOOT?.logFile || path.join(app.getPath('userData'), 'updater.log');
const ulog = (m) => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`); } catch {} };
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json');
const prefs = { autoUpdate: true, autoRestart: false, ...(readJson(PREFS_FILE) || {}) };
const savePrefs = () => { try { fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true }); fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs)); } catch {} };

const UPDATE_URLS = process.env.JARVIS_UPDATE_URL
  ? process.env.JARVIS_UPDATE_URL.split(',').map((s) => s.trim())
  : [`${SERVER_URL}/update.json`, `https://github.com/${APP_CONFIG.updateRepo || 'stimoi/jarvis'}/releases/latest/download/update.json`];
const UPDATES_ON = !!BOOT && !LOCAL && (app.isPackaged || !!process.env.JARVIS_UPDATE_URL);

const publicState = (s) => ({ phase: s.phase, current: s.current, latest: s.latest, percent: s.percent, notes: s.notes, error: s.error });
let lastPhase = '';
function onUpdateState(st) {
  const pub = publicState(st);
  try { if (win && !win.isDestroyed()) win.webContents.send('jarvis:update-state', pub); } catch {}
  try { if (children.agent?.connected) children.agent.send({ t: 'upd', state: pub }); } catch {}
  refreshTray();
  if (st.phase !== lastPhase) {
    lastPhase = st.phase;
    if (st.phase === 'ready') {
      tray?.displayBalloon?.({ title: 'JARVIS', content: `La version ${st.latest} est prête : redémarrez pour l'installer (menu de l'icône).`, iconType: 'info' });
      if (prefs.autoRestart || process.env.JARVIS_UPDATE_AUTOAPPLY) setTimeout(() => installNow(), 3000);
    }
    if (st.phase === 'major') tray?.displayBalloon?.({ title: 'JARVIS', content: `La version ${st.latest} demande une réinstallation (téléchargez-la sur le site).`, iconType: 'info' });
  }
}
const updater = UPDATES_ON
  ? createUpdater({ app, current: APP_VERSION, source: BOOT.source, shellLevel: BOOT.shellLevel, pubkey: BOOT.pubkey, codeDir: BOOT.codeDir, manifestUrls: UPDATE_URLS, log: ulog, onState: onUpdateState })
  : null;

/** Cherche, télécharge si besoin, puis redémarre pour installer. */
async function installNow() {
  if (!updater) return false;
  if (updater.state.phase !== 'ready') await updater.check({ download: true });
  if (updater.state.phase === 'available') await updater.downloadLatest();
  if (updater.state.phase === 'ready') { quitting = true; return updater.apply(); }
  return false;
}

// Réglages des comptes (mail, messageries) : l'appli les transmet à l'agent local, qui les chiffre avec Windows. Rien ne passe par le site.
const acctWaiters = new Map();
function accountCall(op, args) {
  const agent = children.agent;
  if (!agent?.connected) return Promise.reject(new Error("L'agent du PC n'est pas démarré."));
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { acctWaiters.delete(id); reject(new Error('Délai dépassé.')); }, 45000);
    acctWaiters.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    agent.send({ t: 'acct', id, op, args });
  });
}

// ---------------------------------------------------------------- processus enfants
// L'agent n'utilise que des API Node basiques : il tourne avec le Node intégré d'Electron (aucune installation requise).
// Le serveur local (mode développement) a besoin de node:sqlite (Node >= 22.5) : Node du système.
function startChild(name, script) {
  const isAgent = name === 'agent';
  const env = { ...process.env, JARVIS_DATA_DIR: DATA_DIR, HOST: process.env.HOST || '0.0.0.0', JARVIS_APP_VERSION: APP_VERSION };
  if (isAgent) {
    env.ELECTRON_RUN_AS_NODE = '1';
    if (fs.existsSync(PACKED_PIPER)) env.JARVIS_PIPER_DIR = PACKED_PIPER;
  }
  const child = spawn(isAgent ? process.execPath : process.env.JARVIS_NODE || 'node', [path.join(ROOT, script)], {
    cwd: ROOT, env, windowsHide: true,
    stdio: isAgent ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', // canal IPC : l'agent relaie les ordres de mise à jour venant du site
  });
  children[name] = child;
  if (isAgent) {
    child.on('message', (m) => {
      if (m?.t === 'acct-reply') { const w = acctWaiters.get(m.id); if (w) { acctWaiters.delete(m.id); m.ok ? w.resolve(m.result) : w.reject(new Error(m.error || 'Échec')); } return; }
      if (m?.t !== 'cmd') return;
      if (!updater) return child.connected && child.send({ t: 'upd', state: { phase: 'unsupported', current: APP_VERSION } });
      if (m.cmd === 'update') installNow().catch((e) => ulog(`installNow : ${e.message}`));
      else updater.check({ download: prefs.autoUpdate }).catch(() => {});
    });
    child.on('spawn', () => { if (updater) setTimeout(() => child.connected && child.send({ t: 'upd', state: publicState(updater.state) }), 1500); });
  }
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

// ---------------------------------------------------------------- fenêtre + icône
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
  win.webContents.on('did-finish-load', () => { if (updater) onUpdateState(updater.state); });
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

// 2e écran JARVIS (/dash) : plein écran sur le moniteur secondaire s'il y en a un, sinon fenêtre normale.
let dashWin = null;
function openDash() {
  if (dashWin && !dashWin.isDestroyed()) { dashWin.show(); dashWin.focus(); return; }
  const { screen } = require('electron');
  const primary = screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
  const b = (other || primary).bounds;
  dashWin = new BrowserWindow({
    ...(other ? { x: b.x, y: b.y, width: b.width, height: b.height, fullscreen: true } : { width: 1280, height: 760 }),
    backgroundColor: '#010812', title: 'JARVIS — 2e écran', icon: ICON, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  dashWin.loadURL(`${SERVER_URL}/dash/`);
  dashWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  dashWin.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== ORIGIN) { e.preventDefault(); shell.openExternal(url); } });
  dashWin.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape' && dashWin.isFullScreen()) dashWin.setFullScreen(false); });
  dashWin.on('closed', () => { dashWin = null; });
}

const isPaused = () => fs.existsSync(PAUSE_FILE);

function refreshTray() {
  if (!tray) return;
  const s = updater?.state;
  const items = [
    { label: 'Ouvrir JARVIS', click: showWindow },
    { label: 'Ouvrir le 2e écran', click: openDash },
    { type: 'separator' },
    {
      label: 'Suspendre le contrôle du PC', type: 'checkbox', checked: isPaused(),
      click: (item) => { item.checked ? fs.writeFileSync(PAUSE_FILE, '') : fs.rmSync(PAUSE_FILE, { force: true }); refreshTray(); },
    },
    {
      label: 'Lancer au démarrage de Windows', type: 'checkbox', checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: `JARVIS v${APP_VERSION}`, enabled: false },
  ];
  if (updater) {
    if (s.phase === 'ready') items.push({ label: `Redémarrer pour installer la v${s.latest}`, click: () => installNow() });
    else if (s.phase === 'downloading') items.push({ label: `Téléchargement de la v${s.latest}… ${s.percent} %`, enabled: false });
    else if (s.phase === 'available') items.push({ label: `Installer la v${s.latest}`, click: () => installNow() });
    else if (s.phase === 'major') items.push({ label: `v${s.latest} : réinstallation nécessaire (site)`, click: () => shell.openExternal(`${SERVER_URL}/download`) });
    else items.push({ label: s.phase === 'checking' ? 'Recherche de mises à jour…' : 'Rechercher une mise à jour', enabled: s.phase !== 'checking', click: () => updater.check({ download: prefs.autoUpdate }) });
    items.push(
      { label: 'Mises à jour automatiques', type: 'checkbox', checked: prefs.autoUpdate, click: (i) => { prefs.autoUpdate = i.checked; savePrefs(); } },
      { label: 'Redémarrer seul pour installer', type: 'checkbox', checked: prefs.autoRestart, click: (i) => { prefs.autoRestart = i.checked; savePrefs(); } },
    );
  }
  items.push({ type: 'separator' }, { label: 'Quitter JARVIS', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.setToolTip(`JARVIS v${APP_VERSION} — à l’écoute`);
  refreshTray();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ---------------------------------------------------------------- IPC (interface web <-> appli)
ipcMain.handle('jarvis:hostname', () => os.hostname());
ipcMain.handle('jarvis:agent-configured', () => !!readJson(AGENT_CONFIG)?.token);
ipcMain.handle('jarvis:connect-agent', (_e, cfg) => {
  if (!cfg?.server || !cfg?.token) throw new Error('Configuration invalide');
  if (new URL(cfg.server).origin !== ORIGIN) throw new Error('Serveur inattendu');
  const prev = readJson(AGENT_CONFIG) || {};
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify({ autonomy: 'balanced', ...prev, ...cfg }, null, 2), { mode: 0o600 });
  children.agent?.kill(); // redémarré automatiquement avec la nouvelle configuration
  return true;
});
ipcMain.handle('jarvis:get-autonomy', () => readJson(AGENT_CONFIG)?.autonomy || 'balanced');
ipcMain.handle('jarvis:set-autonomy', (_e, v) => {
  if (!['cautious', 'balanced', 'trusting'].includes(v)) return false;
  const cfg = readJson(AGENT_CONFIG);
  if (!cfg) return false;
  cfg.autonomy = v;
  fs.writeFileSync(AGENT_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return true;
});
// Seules les pages du site JARVIS (jamais une page tierce) peuvent régler les comptes.
ipcMain.handle('jarvis:acct', (e, op, args) => {
  if (!String(e.senderFrame?.url || '').startsWith(`${ORIGIN}/`)) throw new Error('Origine non autorisée.');
  if (!['status', 'mail-setup', 'mail-remove', 'msg-setup'].includes(op)) throw new Error('Opération inconnue.');
  return accountCall(op, args && typeof args === 'object' ? args : {});
});
ipcMain.handle('jarvis:app-info', () => ({ version: APP_VERSION, source: BOOT?.source || 'dev', bundled: BOOT?.bundledVersion || APP_VERSION, updates: !!updater }));
ipcMain.handle('jarvis:update-state', () => (updater ? publicState(updater.state) : { phase: 'unsupported', current: APP_VERSION }));
ipcMain.handle('jarvis:update-check', async () => (updater ? publicState(await updater.check({ download: prefs.autoUpdate })) : { phase: 'unsupported', current: APP_VERSION }));
ipcMain.handle('jarvis:update-install', () => installNow());
ipcMain.handle('jarvis:update-prefs', () => ({ ...prefs }));
ipcMain.handle('jarvis:update-set-prefs', (_e, p) => {
  if (typeof p?.autoUpdate === 'boolean') prefs.autoUpdate = p.autoUpdate;
  if (typeof p?.autoRestart === 'boolean') prefs.autoRestart = p.autoRestart;
  savePrefs(); refreshTray();
  return { ...prefs };
});

// ---------------------------------------------------------------- démarrage
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
  // Le micro doit rester actif en arrière-plan : la fenêtre est créée même si elle reste masquée.
  createWindow();
  if (process.argv.includes('--hidden')) win.hide();

  if (updater) {
    // Démarrage réussi => la version téléchargée devient « confirmée » ; sinon elle sera abandonnée au 4e lancement raté.
    setTimeout(() => updater.confirm(), Number(process.env.JARVIS_UPDATE_CONFIRM_MS || 8000));
    // Recherche peu après le démarrage, puis toutes les 6 h.
    setTimeout(() => updater.check({ download: prefs.autoUpdate }), Number(process.env.JARVIS_UPDATE_FIRST_MS || 25000));
    setInterval(() => updater.check({ download: prefs.autoUpdate }), 6 * 3600 * 1000).unref();
  }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; Object.values(children).forEach((c) => c.kill()); });
app.on('window-all-closed', () => {}); // reste actif dans la zone de notification
