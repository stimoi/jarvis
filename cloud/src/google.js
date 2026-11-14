// Connexion Google (Gmail + Agenda) : OAuth « serveur web », jeton de rafraîchissement chiffré en D1,
// outils JARVIS gmail_* / gcal_*. Le contenu des mails n'est jamais stocké : il est relu à la demande.
import { b64u, signToken, verifyToken, randomToken } from './util.js';
import { DEFAULT_TZ, validTz, dayKey, wallToEpoch, resolveRange } from '../../shared/info.js';
import { loadInfo } from './info.js';

// Droits les plus étroits possibles : lecture du mail, envoi, événements d'agenda (pas de suppression de mails).
export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

const enc = new TextEncoder();
const dec = new TextDecoder();
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';

export const googleReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.SESSION_SECRET);

class GoogleError extends Error {}

// ---------------------------------------------------------------- chiffrement du jeton de rafraîchissement (AES-GCM)
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`jarvis-google-rt:${env.SESSION_SECRET}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64u.encode(out);
}
async function unseal(env, blob) {
  const bytes = b64u.decode(blob);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(env), bytes.slice(12)));
}

// ---------------------------------------------------------------- OAuth
export async function authUrl(env, userId) {
  if (!googleReady(env)) throw new GoogleError("La connexion Google n'est pas configurée sur ce serveur.");
  const state = await signToken({ sub: userId, kind: 'gstate', n: randomToken(8) }, env.SESSION_SECRET, 600);
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline', // jeton de rafraîchissement
    prompt: 'consent', // le renvoie même si l'utilisateur s'était déjà connecté
    include_granted_scopes: 'false',
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(env, params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new GoogleError(data.error_description || data.error || `Google ${r.status}`), { code: data.error });
  return data;
}

/** Retour de Google : GET /auth/google/callback?code=…&state=… */
export async function handleCallback(env, url) {
  const done = (q) => Response.redirect(new URL(`/chat/?${q}`, url).href, 302);
  if (!googleReady(env)) return done('google=error');
  if (url.searchParams.get('error')) return done('google=denied');
  const st = await verifyToken(url.searchParams.get('state') || '', env.SESSION_SECRET);
  const code = url.searchParams.get('code');
  if (!st || st.kind !== 'gstate' || !code) return done('google=error');
  try {
    const t = await tokenRequest(env, { code, grant_type: 'authorization_code', redirect_uri: env.GOOGLE_REDIRECT_URI });
    const granted = String(t.scope || '').split(' ');
    const need = SCOPES.filter((s) => s.startsWith('https://'));
    if (!t.refresh_token || need.some((s) => !granted.includes(s))) return done('google=scopes');
    const me = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    await env.DB.prepare(
      'INSERT INTO google_accounts (user_id, email, refresh_enc, scopes, created_at) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_enc = excluded.refresh_enc, scopes = excluded.scopes, created_at = excluded.created_at',
    ).bind(st.sub, String(me.email || '').slice(0, 200), await seal(env, t.refresh_token), t.scope || '', Date.now()).run();
    cache.delete(st.sub);
    return done('google=ok');
  } catch (e) {
    console.error('google callback', e.message);
    return done('google=error');
  }
}

export async function status(env, userId) {
  const row = await env.DB.prepare('SELECT email, created_at FROM google_accounts WHERE user_id = ?').bind(userId).first();
  return { available: googleReady(env), connected: !!row, email: row?.email || '', since: row?.created_at || null };
}

export const isConnected = async (env, userId) => !!(await env.DB.prepare('SELECT 1 AS x FROM google_accounts WHERE user_id = ?').bind(userId).first());

/** Déconnecte : révoque le jeton chez Google (au mieux) puis l'efface. */
export async function disconnect(env, userId) {
  const row = await env.DB.prepare('SELECT refresh_enc FROM google_accounts WHERE user_id = ?').bind(userId).first();
  if (row) {
    try {
      await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: await unseal(env, row.refresh_enc) }) });
    } catch {}
  }
  await env.DB.prepare('DELETE FROM google_accounts WHERE user_id = ?').bind(userId).run();
  cache.delete(userId);
}

// ---------------------------------------------------------------- jeton d'accès (mis en cache par instance)
const cache = new Map(); // userId -> { token, exp }
async function accessToken(env, userId) {
  const hit = cache.get(userId);
  if (hit && hit.exp > Date.now() + 30000) return hit.token;
  const row = await env.DB.prepare('SELECT refresh_enc FROM google_accounts WHERE user_id = ?').bind(userId).first();
  if (!row) throw new GoogleError("Google n'est pas connecté : l'utilisateur doit le faire dans Réglages › Google.");
  try {
    const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: await unseal(env, row.refresh_enc) });
    cache.set(userId, { token: t.access_token, exp: Date.now() + (t.expires_in || 3000) * 1000 });
    return t.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      await env.DB.prepare('DELETE FROM google_accounts WHERE user_id = ?').bind(userId).run();
      throw new GoogleError("L'accès Google a été révoqué ou a expiré : reconnecte Google dans Réglages.");
    }
    throw e;
  }
}

async function gfetch(env, userId, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await accessToken(env, userId)}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(data.error?.message || `Google ${r.status}`);
  return data;
}

// ---------------------------------------------------------------- Gmail
const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function textOf(part) {
  if (!part) return '';
  const own = part.body?.data ? dec.decode(b64u.decode(part.body.data)) : '';
  if (part.mimeType === 'text/plain' && own) return own;
  const kids = (part.parts || []).map(textOf);
  const plain = kids.find((k) => k);
  if (plain) return plain;
  if (part.mimeType === 'text/html' && own) return own.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  return '';
}

async function gmailList(env, userId, a) {
  const limit = Math.max(1, Math.min(15, Number(a.limit) || 8));
  const q = [a.unread ? 'is:unread' : '', a.from ? `from:${clean(a.from, 80)}` : '', a.text ? clean(a.text, 120) : ''].filter(Boolean).join(' ');
  const p = new URLSearchParams({ maxResults: String(limit), labelIds: 'INBOX' });
  if (q) p.set('q', q);
  const list = await gfetch(env, userId, `${GMAIL}/messages?${p}`);
  if (!list.messages?.length) return 'Aucun mail correspondant.';
  const metas = await Promise.all(list.messages.map((m) =>
    gfetch(env, userId, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
  return metas.map((m) => `[${m.id}] ${m.labelIds?.includes('UNREAD') ? '(non lu) ' : ''}${clean(header(m, 'From'), 70)} — ${clean(header(m, 'Subject'), 100) || '(sans objet)'} — ${clean(header(m, 'Date'), 40)}`).join('\n');
}

async function gmailRead(env, userId, a) {
  const id = String(a.id || '');
  if (!/^[0-9a-f]{8,32}$/i.test(id)) throw new GoogleError('Identifiant de mail invalide (utilise celui donné par gmail_list).');
  const m = await gfetch(env, userId, `${GMAIL}/messages/${id}?format=full`);
  const body = textOf(m.payload).replace(/\s+\n/g, '\n').trim().slice(0, 6000);
  return `De : ${clean(header(m, 'From'), 120)}\nObjet : ${clean(header(m, 'Subject'), 200)}\nDate : ${clean(header(m, 'Date'), 40)}\n\n${body || '(aucun texte lisible)'}`;
}

const b64 = (s) => {
  const bytes = enc.encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

async function gmailSend(env, userId, a) {
  const to = clean(a.to, 200);
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) throw new GoogleError('Adresse du destinataire invalide.');
  const subject = clean(a.subject, 200);
  const body = String(a.body ?? '').slice(0, 20000);
  const raw = [`To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(body).replace(/(.{76})/g, '$1\r\n')].join('\r\n');
  await gfetch(env, userId, `${GMAIL}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: b64u.encode(enc.encode(raw)) }) });
  return `Mail envoyé à ${to}.`;
}

// ---------------------------------------------------------------- Agenda
async function tzOf(env) {
  const tz = (await loadInfo(env)).tz || DEFAULT_TZ;
  return validTz(tz) ? tz : DEFAULT_TZ;
}
const fmt = (iso, tz, allDay) =>
  allDay ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });

async function calList(env, userId, a) {
  const tz = await tzOf(env);
  const { from, to } = resolveRange(a, Date.now(), tz);
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  const min = new Date(wallToEpoch(y1, m1, d1, 0, 0, tz)).toISOString();
  const max = new Date(wallToEpoch(y2, m2, d2, 23, 59, tz) + 60000).toISOString();
  const p = new URLSearchParams({ timeMin: min, timeMax: max, singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
  const data = await gfetch(env, userId, `${CAL}/events?${p}`);
  if (!data.items?.length) return `Aucun événement du ${from} au ${to}.`;
  return data.items.map((e) => {
    const allDay = !!e.start?.date;
    return `${fmt(e.start?.dateTime || e.start?.date, tz, allDay)}${allDay ? ' (journée)' : ''} — ${clean(e.summary, 100) || '(sans titre)'}${e.location ? ` @ ${clean(e.location, 60)}` : ''}`;
  }).join('\n');
}

async function calCreate(env, userId, a) {
  const tz = await tzOf(env);
  const title = clean(a.title, 150);
  if (!title) throw new GoogleError("Titre de l'événement manquant.");
  const m = String(a.start || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) throw new GoogleError('Date de début invalide : utilise AAAA-MM-JJ ou AAAA-MM-JJTHH:MM (heure locale).');
  const ev = { summary: title };
  if (a.location) ev.location = clean(a.location, 200);
  if (a.description) ev.description = String(a.description).slice(0, 2000);
  if (m[4] === undefined) {
    const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)).toISOString().slice(0, 10);
    ev.start = { date: `${m[1]}-${m[2]}-${m[3]}` };
    ev.end = { date: next };
  } else {
    const minutes = Math.max(5, Math.min(24 * 60, Number(a.duration_min) || 60));
    const startMs = wallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
    ev.start = { dateTime: new Date(startMs).toISOString(), timeZone: tz };
    ev.end = { dateTime: new Date(startMs + minutes * 60000).toISOString(), timeZone: tz };
  }
  await gfetch(env, userId, `${CAL}/events`, { method: 'POST', body: JSON.stringify(ev) });
  return `Événement créé : ${title}, ${fmt(ev.start.dateTime || ev.start.date, tz, !!ev.start.date)}.`;
}

// ---------------------------------------------------------------- outils
const RUN = { gmail_list: gmailList, gmail_read: gmailRead, gmail_send: gmailSend, gcal_list: calList, gcal_create: calCreate };
/** Outils qui agissent au nom de l'utilisateur : le hub demande sa validation avant de les lancer. */
export const NEEDS_APPROVAL = new Set(['gmail_send', 'gcal_create']);

export function approvalSummary(name, a) {
  if (name === 'gmail_send') return `Envoyer un mail à ${clean(a.to, 200)}\nObjet : ${clean(a.subject, 200)}\n\n${String(a.body ?? '').slice(0, 800)}`;
  return `Créer l'événement « ${clean(a.title, 150)} » le ${clean(a.start, 20)}${a.duration_min ? ` (${Number(a.duration_min)} min)` : ''}${a.location ? ` à ${clean(a.location, 80)}` : ''}`;
}

export async function googleTool(env, userId, name, args) {
  const fn = RUN[name];
  if (!fn) return `Outil inconnu : ${name}`;
  try {
    return await fn(env, userId, args || {});
  } catch (e) {
    if (e instanceof GoogleError) return `Erreur : ${e.message}`;
    throw e;
  }
}
