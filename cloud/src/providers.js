// Fournisseurs IA du Worker : principal (secret AI_API_KEY) -> clés de secours saisies dans l'appli (chiffrées en D1)
// -> Cloudflare Workers AI (binding `AI`, sans clé, quota gratuit quotidien) en dernier recours.
import { resolveProviders, FALLBACKS, fallbackConfig } from '../../shared/aiconf.js';
import { b64u } from './util.js';

export const getEnv = (env) => (...keys) => {
  for (const k of keys) if (typeof env[k] === 'string' && env[k].trim()) return env[k].trim();
  return '';
};

// ---------------------------------------------------------------- chiffrement des clés (AES-GCM, clé dérivée de JWT_SECRET)
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`jarvis-providers:${env.JWT_SECRET}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64u.encode(out);
}
async function unseal(env, blob) {
  try {
    const raw = b64u.decode(blob);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(env), raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return '';
  }
}

export const _seal = seal; export const _unseal = unseal; // pour les tests

// ---------------------------------------------------------------- clés stockées
export async function storedKeys(env) {
  const { results } = await env.DB.prepare("SELECT k, v FROM settings WHERE k LIKE 'pk:%'").all();
  const out = {};
  for (const r of results) {
    const id = r.k.slice(3);
    if (FALLBACKS[id]) out[id] = await unseal(env, r.v);
  }
  return out;
}
export async function saveKey(env, id, key) {
  await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(`pk:${id}`, await seal(env, key)).run();
}
export const deleteKey = (env, id) => env.DB.prepare('DELETE FROM settings WHERE k = ?').bind(`pk:${id}`).run();

// ---------------------------------------------------------------- Workers AI
export const WORKERS_AI = {
  chat: ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', '@cf/meta/llama-4-scout-17b-16e-instruct'],
  vision: '@cf/meta/llama-4-scout-17b-16e-instruct',
  stt: '@cf/openai/whisper-large-v3-turbo',
};

export function workersAiProvider(env) {
  if (!env.AI) return null;
  return {
    provider: 'cloudflare',
    chatModel: WORKERS_AI.chat[0],
    fallbackModels: WORKERS_AI.chat.slice(1),
    visionModel: WORKERS_AI.vision,
    run: (model, body) => env.AI.run(model, body),
  };
}

/** Liste ordonnée des fournisseurs pour une demande de chat. */
export async function loadProviders(env) {
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k = 'chatModel'").first();
  const list = resolveProviders(getEnv(env), await storedKeys(env), row?.v ? { chatModel: row.v } : {});
  const cf = workersAiProvider(env);
  if (cf) list.push(cf);
  return list;
}

/** Transcription de secours via Workers AI (Whisper) quand le fournisseur principal est en quota. */
export async function transcribeWorkersAi(env, buffer) {
  if (!env.AI) return null;
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const out = await env.AI.run(WORKERS_AI.stt, { audio: btoa(bin), language: 'fr' });
  return String(out?.text ?? '').trim();
}

/** État affiché dans les réglages. */
export async function providersStatus(env) {
  const stored = await storedKeys(env);
  const get = getEnv(env);
  const list = Object.entries(FALLBACKS).map(([id, f]) => {
    const key = stored[id] || get(...f.env);
    return { id, name: f.name, signup: f.signup, note: f.note, configured: !!key, source: stored[id] ? 'app' : key ? 'secret' : '', hint: key ? `…${key.slice(-4)}` : '' };
  });
  return { fallbacks: list, workersAi: !!env.AI, order: ['principal', ...list.filter((p) => p.configured).map((p) => p.id), ...(env.AI ? ['cloudflare'] : [])] };
}

export { fallbackConfig };
