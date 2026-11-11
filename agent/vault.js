// Coffre des identifiants (mot de passe d'application mail, jeton Telegram, webhook Discord) :
// chiffrés avec Windows DPAPI (portée « utilisateur actuel ») : seul ce compte Windows, sur ce PC, peut les relire.
// Le texte clair ne passe que par l'entrée standard de PowerShell (jamais dans la ligne de commande) et ne quitte jamais le PC.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'accounts.json');

function ps(script, input) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error) throw new Error(`PowerShell indisponible : ${r.error.message}`);
  if (r.status !== 0) throw new Error(`Coffre : ${String(r.stderr || '').trim().slice(0, 200) || `code ${r.status}`}`);
  return String(r.stdout).trim();
}

export function seal(text) {
  return ps("Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))", text);
}
export function unseal(blob) {
  return ps("Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($s); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))", blob);
}

export function readAccounts() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
export function writeAccounts(a) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}
