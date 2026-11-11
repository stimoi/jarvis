import fs from 'node:fs';
import os from 'node:os';
import dns from 'node:dns';
import WebSocket from 'ws';
import { loadConfig, audit, PAUSE_FILE, CONFIG_FILE } from './config.js';
import { assess, needsApproval, describe } from './safety.js';
import { TOOL_IMPL } from './tools.js';
import { sampleStats } from './stats.js';
import { ttsAvailable } from './tts.js';
import { createRemote } from './remote.js';
import { mailSetup, mailStatus, mailRemove } from './mail.js';
import { messagingSetup, messagingStatus } from './messaging.js';

async function accountOp(op, a) {
  if (op === 'status') return { mail: mailStatus(), messaging: messagingStatus() };
  if (op === 'mail-setup') return { mail: await mailSetup(a) };
  if (op === 'mail-remove') return { mail: mailRemove() };
  if (op === 'msg-setup') return { messaging: await messagingSetup(a) };
  throw new Error('Opération inconnue.');
}

const log = (...a) => console.log(`[agent ${new Date().toLocaleTimeString('fr-FR')}]`, ...a);

let ws = null;
let backoff = 1000;
let statsTimer = null;
let pingTimer = null;
const pending = new Map(); // callId -> resolve(approved)

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Contrôle à distance (écran + souris + clavier) : trames JPEG envoyées en binaire, préfixées par l'octet 0x01.
const remote = createRemote({
  sendJson: (m) => send(m),
  sendFrame: (jpeg) => {
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) ws.send(Buffer.concat([Buffer.from([1]), jpeg]), { binary: true });
  },
  notify: (title, message) => TOOL_IMPL.notify({ title, message }).catch(() => {}),
});

function setStats(on) {
  clearInterval(statsTimer);
  statsTimer = null;
  if (!on) return;
  const tick = () => send({ type: 'stats', stats: sampleStats() });
  tick();
  statsTimer = setInterval(tick, 2500);
}

function askApproval(callId, name, args, level, reason) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(callId);
      send({ type: 'approval_cancelled', callId });
      resolve(false);
    }, 120000);
    pending.set(callId, (ok) => {
      clearTimeout(timer);
      pending.delete(callId);
      resolve(ok);
    });
    send({ type: 'approval_request', callId, tool: name, level, reason, summary: describe(name, args) });
  });
}

async function onToolCall({ callId, name, args = {} }) {
  const cfg = loadConfig() || {};
  const reply = (r) => send({ type: 'tool_result', callId, ...r });
  const impl = TOOL_IMPL[name];

  if (fs.existsSync(PAUSE_FILE)) {
    audit({ tool: name, decision: 'paused' });
    return reply({ ok: false, error: 'Le contrôle du PC est suspendu (fichier PAUSE présent).' });
  }
  if (!impl) return reply({ ok: false, error: `Outil inconnu : ${name}` });

  let verdict;
  try {
    verdict = assess(name, args);
  } catch (e) {
    verdict = { level: 'danger', reason: `Évaluation impossible : ${e.message}` };
  }
  const ask = needsApproval(verdict.level, cfg.autonomy || 'balanced');
  let decision = ask ? 'asked' : 'auto';

  if (ask) {
    log(`validation demandée (${verdict.level}) : ${name} — ${verdict.reason}`);
    const ok = await askApproval(callId, name, args, verdict.level, verdict.reason);
    decision = ok ? 'approved' : 'denied';
    if (!ok) {
      audit({ tool: name, level: verdict.level, decision, args: JSON.stringify(args).slice(0, 500) });
      return reply({ ok: false, error: "Refusé par l'utilisateur (ou délai de validation expiré). N'insiste pas." });
    }
  }

  const t0 = Date.now();
  try {
    const out = await impl(args);
    if (name !== 'tts') audit({ tool: name, level: verdict.level, decision, ms: Date.now() - t0, args: JSON.stringify(args).slice(0, 500) });
    reply({ ok: true, text: out.text, image: out.image, audio: out.audio });
  } catch (e) {
    audit({ tool: name, level: verdict.level, decision, error: e.message, args: JSON.stringify(args).slice(0, 500) });
    reply({ ok: false, error: e.message });
  }
}

// JARVIS_DNS=1.1.1.1 : résout le serveur via un DNS précis (utile si le routeur met en cache une mauvaise réponse).
// Par défaut : DNS du système ; s'il ne trouve pas le serveur (cache négatif du routeur…), repli sur 1.1.1.1 / 8.8.8.8.
function customLookup() {
  const forced = process.env.JARVIS_DNS;
  const resolver = new dns.Resolver();
  resolver.setServers((forced || '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()));
  const viaPublic = (host, opts, cb) =>
    resolver.resolve4(host, (err, addrs) => {
      if (err) return cb(err);
      if (opts?.all) return cb(null, addrs.map((address) => ({ address, family: 4 })));
      cb(null, addrs[0], 4);
    });
  if (forced) return viaPublic;
  return (host, opts, cb) =>
    dns.lookup(host, opts, (err, ...rest) => (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') ? viaPublic(host, opts, cb) : cb(err, ...rest)));
}

function connect(cfg) {
  const url = cfg.server.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
  log(`connexion à ${url}`);
  // Le jeton d'appareil passe dans le sous-protocole WebSocket, jamais dans l'URL.
  ws = new WebSocket(url, ['jarvis.v1', cfg.token], { maxPayload: 32 * 1024 * 1024, lookup: customLookup() });

  ws.on('open', () => {
    send({
      type: 'hello',
      info: { name: cfg.name || os.hostname(), os: `${os.type()} ${os.release()} (${os.arch()})`, user: os.userInfo().username, home: os.homedir(), tts: ttsAvailable(), version: process.env.JARVIS_APP_VERSION || '', canUpdate: !!process.send },
    });
    if (lastUpd) send({ type: 'app_status', state: lastUpd });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25000);
  });

  ws.on('message', (raw) => {
    const text = raw.toString();
    if (text === 'pong') return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'ready') {
      backoff = 1000;
      log('connecté — en attente des ordres de JARVIS.');
    } else if (msg.type === 'tool_call') {
      onToolCall(msg).catch((e) => log('erreur outil', e));
    } else if (msg.type === 'approval_decision') {
      pending.get(msg.callId)?.(!!msg.approved);
    } else if (msg.type === 'app_cmd') {
      // Mise à jour de l'appli de bureau demandée depuis le site / le téléphone : relayée à l'appli (Electron) par le canal IPC.
      if (process.send) process.send({ t: 'cmd', cmd: msg.cmd === 'update' ? 'update' : 'check' });
      else send({ type: 'app_status', state: { phase: 'unsupported', current: process.env.JARVIS_APP_VERSION || '' } });
    } else if (msg.type === 'rc_sub') {
      remote.sub(!!msg.on, msg.opts || {});
    } else if (msg.type === 'rc_input') {
      remote.input(msg.ev);
    } else if (msg.type === 'stats_sub') {
      setStats(!!msg.on);
    } else if (msg.type === 'auth_error') {
      log('jeton refusé : relance `npm run agent:setup` (appareil révoqué ?)');
    }
  });

  ws.on('close', (code) => {
    clearInterval(pingTimer);
    setStats(false);
    remote.sub(false);
    for (const resolve of pending.values()) resolve(false);
    const wait = code === 4003 ? 15000 : backoff;
    log(`déconnecté (${code}), nouvelle tentative dans ${Math.round(wait / 1000)}s`);
    backoff = Math.min(backoff * 2, 30000);
    setTimeout(start, wait);
  });
  ws.on('error', (e) => log('erreur réseau :', e.message));
}

function start() {
  const cfg = loadConfig();
  if (!cfg) {
    log(`pas encore configuré (${CONFIG_FILE}). Lance « npm run agent:setup » ou connecte ce PC depuis l'appli de bureau.`);
    return setTimeout(start, 3000);
  }
  connect(cfg);
}

// État des mises à jour (venant de l'appli Electron) -> transmis au site pour affichage (PC connecté : version, téléchargement…)
let lastUpd = null;
process.on('message', async (m) => {
  if (m?.t === 'acct') {
    // Réglages de la boîte mail / des messageries, demandés par l'appli de bureau : les mots de passe restent sur ce PC (coffre Windows).
    const reply = (r) => process.send?.({ t: 'acct-reply', id: m.id, ...r });
    try { reply({ ok: true, result: await accountOp(m.op, m.args || {}) }); } catch (e) { reply({ ok: false, error: e.message }); }
    return;
  }
  if (m?.t !== 'upd') return;
  lastUpd = m.state;
  send({ type: 'app_status', state: m.state });
});

process.on('uncaughtException', (e) => log('exception :', e));
process.on('unhandledRejection', (e) => log('rejet :', e));
start();
