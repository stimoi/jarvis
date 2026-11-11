// Fabrique l'archive de MISE À JOUR de l'appli de bureau (≈ 300 Ko : agent, shared, desktop, ws) et son manifeste SIGNÉ.
//   node scripts/make-update.js [--stage dist/stage] [--out downloads] [--url-base https://…/releases/download/vX.Y.Z] [--notes "texte"] [--shell 1]
// Signature Ed25519 : la clé privée est data/update-key.pem (jamais envoyée nulle part, JAMAIS versionnée : à sauvegarder !).
// La clé publique correspondante est dans desktop/boot.cjs ; sans la clé privée, plus aucune mise à jour n'est possible.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const stage = path.resolve(root, arg('--stage', 'dist/stage'));
const out = path.resolve(root, arg('--out', 'downloads'));
const keyFile = path.join(root, 'data', 'update-key.pem');
if (!fs.existsSync(keyFile)) throw new Error(`Clé de signature introuvable : ${keyFile}`);
if (!fs.existsSync(path.join(stage, 'package.json'))) throw new Error(`Dossier de préparation introuvable : ${stage} (lance d'abord « npm run package »)`);

const version = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version;
const shell = Number(arg('--shell', 1));
const urlBase = (arg('--url-base', '') || '').replace(/\/+$/, '');
fs.mkdirSync(out, { recursive: true });
const zipName = `JARVIS-update-${version}.zip`;
const zipPath = path.join(out, zipName);

const z = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'make-zip.ps1'), '-Source', stage, '-Dest', zipPath], { stdio: 'inherit' });
if (z.status !== 0) throw new Error('Création du zip de mise à jour impossible');

const bytes = fs.readFileSync(zipPath);
const manifest = {
  version,
  shell,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
  url: `${urlBase}/${zipName}`,
  notes: arg('--notes', process.env.UPDATE_NOTES || 'Améliorations et corrections.'),
  date: new Date().toISOString(),
};
// Même chaîne que desktop/updater.cjs (payloadOf)
const payload = `jarvis-update|${manifest.version}|${manifest.shell}|${manifest.sha256}|${manifest.size}|${manifest.url}`;
manifest.sig = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(fs.readFileSync(keyFile))).toString('base64');
fs.writeFileSync(path.join(out, 'update.json'), JSON.stringify(manifest, null, 2));
console.log(`› mise à jour ${version} : ${zipName} (${(bytes.length / 1024).toFixed(0)} Ko), manifeste signé -> ${path.join(out, 'update.json')}`);
