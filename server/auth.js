import crypto from 'node:crypto';
import { config } from './config.js';
import { users, devices } from './db.js';

// ---------- Mots de passe (scrypt) ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(h, 'base64');
  const actual = crypto.scryptSync(pw, Buffer.from(s, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- Jetons de session (HS256) ----------
const b64u = (b) => Buffer.from(b).toString('base64url');

export function signToken(payload, ttlSec = 30 * 24 * 3600) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', config.secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [head, body, sig] = String(token).split('.');
    const expected = crypto.createHmac('sha256', config.secret).update(`${head}.${body}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- Jetons d'appareil (agent PC) ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createDevice(userId, name) {
  const id = crypto.randomUUID();
  const token = `jda_${crypto.randomBytes(32).toString('base64url')}`;
  devices.create(id, userId, name.slice(0, 60), sha(token));
  return { id, token };
}

export function deviceFromToken(token) {
  if (!String(token).startsWith('jda_')) return null;
  return devices.byTokenHash(sha(token)) || null;
}

// ---------- Express ----------
export function userFromToken(token) {
  const p = verifyToken(token);
  if (!p || p.kind !== 'user') return null;
  return users.byId(p.sub) || null;
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'Non authentifié' });
  req.user = user;
  next();
}

const attempts = new Map();
export function rateLimit(max = 12, windowMs = 10 * 60 * 1000) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const rec = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ error: 'Trop de tentatives, réessaie plus tard.' });
    rec.push(now);
    attempts.set(key, rec);
    next();
  };
}

export const publicUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin });
