import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAi } from '../shared/aiconf.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

// Réglages modifiables à chaud depuis l'interface (admin) : data/settings.json
const settingsFile = path.join(DATA_DIR, 'settings.json');
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}
export function saveSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 });
}

const env = (...keys) => {
  for (const k of keys) if (process.env[k]?.trim()) return process.env[k].trim();
  return '';
};

export const config = {
  port: Number(env('PORT') || 8787),
  host: env('HOST') || '0.0.0.0',
  // Le premier compte est toujours autorisé ; ensuite les inscriptions restent fermées sauf ALLOW_SIGNUP=true.
  allowSignup: env('ALLOW_SIGNUP') === 'true',
  secret: loadSecret(),
  // Relu à chaque appel pour prendre en compte les réglages modifiés depuis l'interface.
  get ai() {
    const s = readSettings();
    return { ...resolveAi(env, s), ttsVoice: s.ttsVoice || env('AI_TTS_VOICE') || '', serverTts: false };
  },
};
