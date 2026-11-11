// Worker JARVIS : API (comptes, invitations, voix), liaison WebSocket vers le Durable Object de l'utilisateur,
// interface statique servie par Workers Assets (dossier web/).
import { UserHub } from './hub.js';
import { resolveAi, FALLBACKS, fallbackConfig } from '../../shared/aiconf.js';
import { transcribe, checkKey, AiError } from '../../shared/ai.js';
import { hashPassword, verifyPassword, signToken, verifyToken, sha256hex, randomToken, json } from './util.js';
import { getEnv, providersStatus, saveKey, deleteKey, transcribeWorkersAi } from './providers.js';

export { UserHub };

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const HOUR = 3600 * 1000;

async function aiConf(env) {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'chatModel'").first();
  return resolveAi(getEnv(env), row?.v ? { chatModel: row.v } : {});
}

const publicUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin });
const hub = (env, userId) => env.HUB.get(env.HUB.idFromName(`user:${userId}`));
const ip = (req) => req.headers.get('CF-Connecting-IP') || 'local';

async function userFromToken(env, token) {
  const p = await verifyToken(token, env.JWT_SECRET);
  if (!p || p.kind !== 'user') return null;
  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(p.sub).first()) || null;
}

async function requireUser(req, env) {
  const h = req.headers.get('Authorization') || '';
  return userFromToken(env, h.startsWith('Bearer ') ? h.slice(7) : '');
}

/** Limite de tentatives (connexion / inscription) : 10 par 10 minutes et par clé. */
async function tooMany(env, key, max = 10) {
  const since = Date.now() - 10 * 60 * 1000;
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND ts > ?').bind(key, since).first();
  return (r?.n || 0) >= max;
}
const noteAttempt = (env, key) => env.DB.prepare('INSERT INTO attempts (key, ts) VALUES (?, ?)').bind(key, Date.now()).run();

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function api(req, env, url) {
  const path = url.pathname;
  const m = req.method;

  if (path === '/api/health') return json({ ok: true });

  if (path === '/api/config') {
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
    const ai = await aiConf(env);
    return json({ allowSignup: true, firstUser: n === 0, inviteRequired: n === 0 || env.SIGNUP !== 'open', hasKey: !!ai.key, provider: ai.provider });
  }

  if (path === '/api/register' && m === 'POST') {
    const { username, password, invite } = await readBody(req);
    const k = `reg:${ip(req)}`;
    if (await tooMany(env, k, 8)) return json({ error: 'Trop de tentatives, réessaie plus tard.' }, 429);
    await noteAttempt(env, k);
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
    if (!USERNAME_RE.test(username || '')) return json({ error: "Nom d'utilisateur : 3-32 caractères (lettres, chiffres, _ . -)." }, 400);
    if (typeof password !== 'string' || password.length < 8) return json({ error: 'Mot de passe : 8 caractères minimum.' }, 400);
    let inv = null;
    if (n === 0) {
      // Premier compte (administrateur) : protégé par un code d'installation (secret SETUP_CODE) pour éviter qu'un inconnu ne le prenne.
      const setup = String(env.SETUP_CODE || '').trim();
      if (!setup || String(invite || '').trim() !== setup) return json({ error: "Code d'installation invalide." }, 403);
    } else if (env.SIGNUP !== 'open') {
      inv = await env.DB.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').bind(String(invite || '').trim().toUpperCase()).first();
      if (!inv) return json({ error: "Code d'invitation invalide ou déjà utilisé." }, 403);
    }
    if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) return json({ error: "Ce nom d'utilisateur existe déjà." }, 409);
    const hash = await hashPassword(password, Number(env.PBKDF2_ITER) || 100000);
    const r = await env.DB.prepare('INSERT INTO users (username, pass_hash, is_admin, created_at) VALUES (?,?,?,?)').bind(username, hash, n === 0 ? 1 : 0, Date.now()).run();
    const id = r.meta.last_row_id;
    if (inv) await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').bind(id, Date.now(), inv.code).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return json({ token: await signToken({ sub: id, kind: 'user' }, env.JWT_SECRET), user: publicUser(user) });
  }

  if (path === '/api/login' && m === 'POST') {
    const { username, password } = await readBody(req);
    const k1 = `login:${ip(req)}`;
    const k2 = `login:u:${String(username || '').toLowerCase()}`;
    if ((await tooMany(env, k1, 15)) || (await tooMany(env, k2, 8))) return json({ error: 'Trop de tentatives, réessaie plus tard.' }, 429);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(String(username || '')).first();
    const ok = user && (await verifyPassword(String(password || ''), user.pass_hash));
    if (!ok) {
      await Promise.all([noteAttempt(env, k1), noteAttempt(env, k2)]);
      return json({ error: 'Identifiants incorrects.' }, 401);
    }
    await env.DB.prepare('DELETE FROM attempts WHERE key = ?').bind(k2).run();
    return json({ token: await signToken({ sub: user.id, kind: 'user' }, env.JWT_SECRET), user: publicUser(user) });
  }

  // ---------- Authentifié ----------
  const user = await requireUser(req, env);
  if (!user) return json({ error: 'Non authentifié' }, 401);

  if (path === '/api/me') return json({ user: publicUser(user) });

  if (path === '/api/history') {
    const stub = hub(env, user.id);
    if (m === 'DELETE') {
      await stub.clearHistory();
      return json({ ok: true });
    }
    return json({ messages: await stub.history(40) });
  }

  if (path === '/api/devices' && m === 'GET') {
    const online = new Set((await hub(env, user.id).agentIds()) || []);
    const { results } = await env.DB.prepare('SELECT id, name, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY created_at').bind(user.id).all();
    return json({ devices: results.map((d) => ({ ...d, online: online.has(d.id) })) });
  }
  if (path === '/api/devices' && m === 'POST') {
    const body = await readBody(req);
    const id = crypto.randomUUID();
    const token = `jda_${randomToken(32)}`;
    await env.DB.prepare('INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .bind(id, user.id, String(body.name || 'PC').slice(0, 60), await sha256hex(token), Date.now()).run();
    return json({ id, token });
  }
  const dm = path.match(/^\/api\/devices\/([\w-]+)$/);
  if (dm && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM devices WHERE user_id = ? AND id = ?').bind(user.id, dm[1]).run();
    await hub(env, user.id).kick(dm[1]);
    return json({ ok: true });
  }

  if (path === '/api/settings' && m === 'GET') {
    const ai = await aiConf(env);
    return json({ hasKey: !!ai.key, provider: ai.provider, serverTts: false, keyHint: ai.key ? `…${ai.key.slice(-4)}` : '', chatModel: ai.chatModel, isAdmin: !!user.is_admin, cloud: true });
  }
  if (path === '/api/settings' && m === 'PUT') {
    if (!user.is_admin) return json({ error: 'Réservé à l’administrateur.' }, 403);
    const b = await readBody(req);
    if (b.apiKey) return json({ error: "La clé API se change côté Cloudflare : wrangler secret put AI_API_KEY." }, 400);
    if (typeof b.chatModel === 'string' && b.chatModel.trim()) {
      await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('chatModel', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(b.chatModel.trim()).run();
    }
    return json({ ok: true });
  }

  // ---------- Fournisseurs IA de secours (admin) ----------
  if (path === '/api/providers' && m === 'GET') {
    if (!user.is_admin) return json({ error: 'Réservé à l’administrateur.' }, 403);
    return json(await providersStatus(env));
  }
  const pm = path.match(/^\/api\/providers\/(\w+)$/);
  if (pm) {
    if (!user.is_admin) return json({ error: 'Réservé à l’administrateur.' }, 403);
    if (!FALLBACKS[pm[1]]) return json({ error: 'Fournisseur inconnu.' }, 404);
    if (m === 'DELETE') {
      await deleteKey(env, pm[1]);
      return json({ ok: true });
    }
    if (m === 'PUT') {
      const key = String((await readBody(req)).key || '').trim();
      if (key.length < 12 || /\s/.test(key)) return json({ error: 'Clé invalide.' }, 400);
      try {
        const n = await checkKey(fallbackConfig(pm[1], key)); // refusée => erreur claire, rien n'est enregistré
        await saveKey(env, pm[1], key);
        return json({ ok: true, models: n });
      } catch (e) {
        if (e instanceof AiError) return json({ error: e.message }, e.status === 502 ? 502 : 400);
        throw e;
      }
    }
  }

  // ---------- Invitations (admin) ----------
  if (path === '/api/invites') {
    if (!user.is_admin) return json({ error: 'Réservé à l’administrateur.' }, 403);
    if (m === 'POST') {
      const code = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
      await env.DB.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)').bind(code, user.id, Date.now()).run();
      return json({ code });
    }
    const { results } = await env.DB.prepare('SELECT i.code, i.created_at, i.used_at, u.username AS used_by FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50').all();
    return json({ invites: results });
  }
  const im = path.match(/^\/api\/invites\/([\w]+)$/);
  if (im && m === 'DELETE') {
    if (!user.is_admin) return json({ error: 'Réservé à l’administrateur.' }, 403);
    await env.DB.prepare('DELETE FROM invites WHERE code = ?').bind(im[1]).run();
    return json({ ok: true });
  }

  // ---------- Voix ----------
  if (path === '/api/stt' && m === 'POST') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength < 200) return json({ text: '' });
    if (buf.byteLength > 12 * 1024 * 1024) return json({ error: 'Audio trop volumineux' }, 413);
    const mime = (req.headers.get('Content-Type') || 'audio/wav').split(';')[0];
    try {
      return json({ text: await transcribe(await aiConf(env), buf, mime) });
    } catch (e) {
      // Quota / panne du fournisseur principal : Whisper de Cloudflare Workers AI prend le relais.
      if (!(e instanceof AiError)) throw e;
      try {
        const text = await transcribeWorkersAi(env, buf);
        if (text != null) return json({ text, via: 'cloudflare' });
      } catch (e2) {
        console.error('stt secours', e2);
      }
      throw e;
    }
  }
  if (path === '/api/tts' && m === 'POST') {
    const { text } = await readBody(req);
    if (!String(text || '').trim()) return json({ error: 'Texte vide' }, 400);
    const audio = await hub(env, user.id).tts(String(text).slice(0, 1500));
    if (!audio) return json({ error: 'Aucun PC avec voix Piper : voix du navigateur utilisée.' }, 501);
    return new Response(Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0)), { headers: { 'Content-Type': audio.mime, 'Cache-Control': 'no-store' } });
  }

  return json({ error: 'Introuvable' }, 404);
}

async function websocket(req, env) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
  // Le jeton voyage dans Sec-WebSocket-Protocol : « jarvis.v1, <jeton> » (jamais dans l'URL).
  const token = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim()).find((p) => p && p !== 'jarvis.v1') || '';
  let userId;
  const headers = new Headers(req.headers);
  if (token.startsWith('jda_')) {
    const dev = await env.DB.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await sha256hex(token)).first();
    if (!dev) return new Response('unauthorized', { status: 401 });
    userId = dev.user_id;
    headers.set('X-Role', 'agent');
    headers.set('X-Device-Id', dev.id);
    headers.set('X-Device-Name', encodeURIComponent(dev.name));
    await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(Date.now(), dev.id).run();
  } else {
    const user = await userFromToken(env, token);
    if (!user) return new Response('unauthorized', { status: 401 });
    userId = user.id;
    headers.set('X-Role', 'client');
  }
  const u = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first();
  headers.set('X-User-Id', String(userId));
  headers.set('X-Username', encodeURIComponent(u?.username || 'utilisateur'));
  return hub(env, userId).fetch(new Request(req.url, { headers, method: 'GET' }));
}

async function downloads(req, env, url) {
  if (!env.DOWNLOADS) return json({ error: 'Téléchargements indisponibles' }, 404);
  const name = decodeURIComponent(url.pathname.slice('/downloads/'.length));
  if (!/^[\w.\-]+$/.test(name)) return json({ error: 'Nom invalide' }, 400);
  const obj = await env.DOWNLOADS.get(`downloads/${name}`);
  if (!obj) return json({ error: 'Fichier introuvable' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/ws') return await websocket(req, env);
      if (url.pathname === '/api/downloads') {
        const list = env.DOWNLOADS ? (await env.DOWNLOADS.list({ prefix: 'downloads/' })).objects.map((o) => ({ name: o.key.slice(10), size: o.size, uploaded: o.uploaded })) : [];
        return json({ files: list.filter((f) => f.name) });
      }
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (url.pathname.startsWith('/downloads/')) return await downloads(req, env, url);
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof AiError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Erreur interne' }, 500);
    }
  },
};
