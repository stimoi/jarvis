// Assistant de configuration : associe ce PC à ton compte JARVIS (crée un jeton d'appareil).
import os from 'node:os';
import readline from 'node:readline';
import { saveConfig, loadConfig, CONFIG_FILE } from './config.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') => new Promise((r) => rl.question(def ? `${q} [${def}] ` : `${q} `, (a) => r(a.trim() || def)));
const askHidden = (q) =>
  new Promise((resolve) => {
    process.stdout.write(`${q} `);
    const orig = rl._writeToOutput;
    rl._writeToOutput = () => {};
    rl.question('', (a) => {
      rl._writeToOutput = orig;
      process.stdout.write('\n');
      resolve(a);
    });
  });

async function api(server, path, body, token) {
  const res = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const existing = loadConfig();
console.log('\n  JARVIS — configuration de l\'agent PC\n');
const server = (await ask('Adresse du serveur JARVIS', existing?.server || 'http://localhost:8787')).replace(/\/+$/, '');
const username = await ask('Nom d\'utilisateur');
const password = await askHidden('Mot de passe :');
const name = await ask('Nom de ce PC', existing?.name || os.hostname());

try {
  const { token } = await api(server, '/api/login', { username, password });
  const dev = await api(server, '/api/devices', { name }, token);
  saveConfig({ server, token: dev.token, deviceId: dev.id, name, autonomy: existing?.autonomy || 'balanced' });
  console.log(`\n  ✔ PC « ${name} » associé. Configuration enregistrée dans ${CONFIG_FILE}`);
  console.log('  Lance maintenant : npm start\n');
} catch (e) {
  console.error(`\n  ✘ Échec : ${e.message}\n`);
  process.exitCode = 1;
}
rl.close();
