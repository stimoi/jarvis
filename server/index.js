import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config, saveSettings, ROOT } from './config.js';
import { users, devices, messages } from './db.js';
import {
  hashPassword, verifyPassword, signToken, requireAuth, rateLimit, publicUser, createDevice,
} from './auth.js';
import { Hub } from './hub.js';
import { Brain } from './brain.js';
import { transcribe, AiError } from './ai.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'",
    'Permissions-Policy': 'microphone=(self)',
  });
  next();
});

app.use(express.json({ limit: '100kb' }));

const hub = new Hub();
new Brain(hub, users);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e instanceof AiError ? e.status : 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: e.message });
  });

// ---------- Public ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) =>
  res.json({ allowSignup: config.allowSignup || users.count() === 0, firstUser: users.count() === 0, hasKey: !!config.ai.key, serverTts: config.ai.serverTts, provider: config.ai.provider }),
);

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

app.post('/api/register', rateLimit(), wrap((req, res) => {
  const { username, password } = req.body || {};
  const first = users.count() === 0;
  if (!first && !config.allowSignup) return res.status(403).json({ error: 'Les inscriptions sont fermées.' });
  if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: "Nom d'utilisateur : 3-32 caractères (lettres, chiffres, _ . -)." });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });
  if (users.byName(username)) return res.status(409).json({ error: "Ce nom d'utilisateur existe déjà." });
  const id = users.create(username, hashPassword(password), first);
  const user = users.byId(id);
  res.json({ token: signToken({ sub: id, kind: 'user' }), user: publicUser(user) });
}));

app.post('/api/login', rateLimit(), wrap((req, res) => {
  const { username, password } = req.body || {};
  const user = users.byName(String(username || ''));
  // Vérification même si l'utilisateur n'existe pas (temps constant approximatif)
  const ok = verifyPassword(String(password || ''), user?.pass_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA') && user;
  if (!ok) return res.status(401).json({ error: 'Identifiants incorrects.' });
  res.json({ token: signToken({ sub: user.id, kind: 'user' }), user: publicUser(user) });
}));

// ---------- Authentifié ----------
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/history', requireAuth, (req, res) =>
  res.json({ messages: messages.recent(req.user.id, 40) }),
);
app.delete('/api/history', requireAuth, (req, res) => {
  messages.clear(req.user.id);
  res.json({ ok: true });
});

app.get('/api/devices', requireAuth, (req, res) => {
  const online = new Set(hub.agentsOf(req.user.id).map((a) => a.id));
  res.json({ devices: devices.list(req.user.id).map((d) => ({ ...d, online: online.has(d.id) })) });
});
app.post('/api/devices', requireAuth, (req, res) => {
  const name = String(req.body?.name || 'PC').trim() || 'PC';
  res.json(createDevice(req.user.id, name));
});
app.delete('/api/devices/:id', requireAuth, (req, res) => {
  devices.remove(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, (req, res) => {
  const x = config.ai;
  res.json({
    hasKey: !!x.key,
    provider: x.provider,
    serverTts: x.serverTts,
    keyHint: x.key ? `…${x.key.slice(-4)}` : '',
    chatModel: x.chatModel,
    ttsVoice: x.ttsVoice,
    isAdmin: !!req.user.is_admin,
  });
});
app.put('/api/settings', requireAuth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Réservé à l’administrateur.' });
  const { apiKey, chatModel, ttsVoice } = req.body || {};
  const patch = {};
  if (typeof apiKey === 'string' && apiKey.trim()) patch.apiKey = apiKey.trim();
  if (typeof chatModel === 'string' && chatModel.trim()) patch.chatModel = chatModel.trim();
  if (typeof ttsVoice === 'string' && ttsVoice.trim()) patch.ttsVoice = ttsVoice.trim();
  saveSettings(patch);
  res.json({ ok: true });
});

// Voix : l'audio du micro (WAV 16 kHz) est transcrit par Grok.
app.post('/api/stt', requireAuth, express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '12mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length < 200) return res.json({ text: '' });
  const text = await transcribe(req.body, req.headers['content-type']?.split(';')[0] || 'audio/wav');
  res.json({ text });
}));

app.post('/api/tts', requireAuth, wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texte vide' });
  // La voix est synthétisée sur le PC de l'utilisateur (Piper) via son agent.
  const agents = hub.agentsOf(req.user.id).filter((a) => a.tts);
  if (!agents.length) return res.status(501).json({ error: 'Aucun PC avec voix Piper : voix du navigateur utilisée.' });
  const r = await hub.callTool(req.user.id, agents[agents.length - 1].id, 'tts', { text: text.slice(0, 1500) }, 60000);
  if (!r.ok || !r.audio) return res.status(502).json({ error: r.error || 'Synthèse impossible' });
  res.set('Content-Type', r.audio.mime).send(Buffer.from(r.audio.data, 'base64'));
}));

// ---------- Téléchargements de l'appli de bureau (dossier downloads/) ----------
const DL_DIR = path.join(ROOT, 'downloads');
app.get('/api/downloads', (_req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(DL_DIR).filter((f) => /^[\w.\-]+$/.test(f)).map((name) => ({ name, size: fs.statSync(path.join(DL_DIR, name)).size }));
  } catch {}
  res.json({ files });
});
app.use('/downloads', express.static(DL_DIR, { index: false, setHeaders: (r, p) => r.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`) }));

// ---------- Interface web (PWA) ----------
app.get('/_headers', (_req, res) => res.status(404).end());
app.use(express.static(path.join(ROOT, 'web'), { extensions: ['html'], maxAge: 0 }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Introuvable' }));

const server = http.createServer(app);
hub.attach(server);

server.listen(config.port, config.host, () => {
  console.log(`\n  JARVIS serveur prêt — http://localhost:${config.port}`);
  if (config.host !== '127.0.0.1') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Réseau local (téléphone) : http://${i.address}:${config.port}`);
    }
  }
  if (!config.ai.key) console.log("  ⚠ Clé API absente : renseigne AI_API_KEY dans .env (ou Réglages dans l'app).");
  else console.log(`  IA : ${config.ai.provider} / ${config.ai.chatModel}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
