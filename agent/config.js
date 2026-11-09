import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.JARVIS_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const CONFIG_FILE = process.env.JARVIS_AGENT_CONFIG || path.join(DATA_DIR, 'agent.json');
export const AUDIT_FILE = path.join(DATA_DIR, 'agent-audit.log');
// Interrupteur d'urgence : si ce fichier existe, l'agent refuse toute action.
export const PAUSE_FILE = path.join(DATA_DIR, 'PAUSE');

export function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return c.server && c.token ? c : null;
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function audit(entry) {
  try {
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  } catch {}
}
