// Fabrique l'appli de bureau Windows (dossier autonome + zip dans downloads/).
// Usage : npm run package        (voix Piper incluse si data/piper existe ; --no-voice pour l'exclure)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const withVoice = !process.argv.includes('--no-voice') && fs.existsSync(path.join(root, 'data', 'piper', 'piper', 'piper.exe'));
const stage = path.join(root, 'dist', 'stage');
const out = path.join(root, 'dist');
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} a échoué`);
};

// 1) Dossier de préparation minimal : seulement ce que l'appli installée utilise (agent + coque Electron).
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const d of ['agent', 'shared', 'desktop']) fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
fs.mkdirSync(path.join(stage, 'web', 'icons'), { recursive: true });
fs.cpSync(path.join(root, 'web', 'icons'), path.join(stage, 'web', 'icons'), { recursive: true });
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'jarvis', productName: 'JARVIS', version: pkg.version, description: pkg.description, main: 'desktop/boot.cjs', type: 'module',
  dependencies: { ws: pkg.dependencies.ws },
}, null, 2));
console.log('› installation des dépendances de l\'appli…');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], stage);

// 2) Empaquetage Electron (asar désactivé : l'agent est lancé comme script Node classique)
console.log('› empaquetage Electron…');
const paths = await packager({
  dir: stage, out, name: 'JARVIS', platform: 'win32', arch: 'x64', overwrite: true, asar: false,
  electronVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  icon: path.join(root, 'web', 'icons', 'icon.ico'),
  extraResource: withVoice ? [path.join(root, 'data', 'piper')] : [],
  appCopyright: 'JARVIS',
  win32metadata: { ProductName: 'JARVIS', FileDescription: 'JARVIS — assistant vocal', OriginalFilename: 'JARVIS.exe' },
});
// Dossier final nommé « JARVIS » (c'est lui qui apparaîtra à la racine de l'archive)
const appDir = path.join(out, 'JARVIS');
fs.rmSync(appDir, { recursive: true, force: true });
fs.renameSync(paths[0], appDir);
console.log(`› application : ${appDir}${withVoice ? ' (voix Piper incluse)' : ''}`);

// 3) Archive à distribuer.
// Zip créé par scripts/make-zip.ps1 (chemins « JARVIS/fichier », séparateurs « / ») : `tar -a` produisait des entrées
// « ./fichier » que l'Explorateur Windows ne sait pas lire (« dossier compressé non valide »).
const dl = path.join(root, 'downloads');
fs.mkdirSync(dl, { recursive: true });
const zip = path.join(dl, 'JARVIS-windows-x64.zip');
fs.rmSync(zip, { force: true });
const z = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'make-zip.ps1'), '-Source', appDir, '-Dest', zip, '-Base', 'JARVIS'], { stdio: 'inherit' });
if (z.status !== 0) throw new Error('Création du zip impossible');
console.log(`› archive : ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(0)} Mo)`);
