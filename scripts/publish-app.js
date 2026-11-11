// Publie l'appli de bureau : Release GitHub (zip complet + mise à jour signée) + redéploiement du site.
//  • https://jarvis.avenox.fr/download            -> dernier zip complet (première installation)
//  • https://jarvis.avenox.fr/update.json         -> manifeste SIGNÉ lu par les applis installées (mise à jour à distance)
// Prérequis : `gh auth login` fait, dépôt GitHub créé (origin), clé de signature data/update-key.pem.
// Usage : npm run publish:app            (--skip-build pour réutiliser le dernier `npm run package`)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wr = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const NAME = 'JARVIS-windows-x64.zip';
const ZIP = path.join(root, 'downloads', NAME);
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
const node = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env });
const gh = (args, capture = true) => spawnSync('gh', args, { cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });

if (!process.argv.includes('--skip-build')) {
  console.log('› construction de l’appli…');
  if (node(['scripts/package.js']).status !== 0) process.exit(1);
}
if (!fs.existsSync(ZIP)) throw new Error(`Archive introuvable : ${ZIP}`);

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).stdout.trim();
if (!repo) throw new Error('Dépôt GitHub introuvable : fais « gh auth login » et pousse le dépôt (origin).');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

console.log('› archive de mise à jour signée…');
if (node(['scripts/make-update.js', '--url-base', `https://github.com/${repo}/releases/download/${tag}`]).status !== 0) process.exit(1);
const UPDATE_ZIP = path.join(root, 'downloads', `JARVIS-update-${version}.zip`);
const MANIFEST = path.join(root, 'downloads', 'update.json');

console.log(`› Release GitHub ${repo} ${tag}…`);
const assets = [ZIP, UPDATE_ZIP, MANIFEST];
const exists = gh(['release', 'view', tag]).status === 0;
const notes = `JARVIS ${tag} pour Windows 10/11 64 bits. Première installation : décompressez ${NAME} puis lancez JARVIS.exe. Les applis déjà installées (v0.4.0+) se mettent à jour toutes seules.`;
const r = exists
  ? gh(['release', 'upload', tag, ...assets, '--clobber', '--repo', repo], false)
  : gh(['release', 'create', tag, ...assets, '--repo', repo, '--title', `JARVIS ${tag}`, '--notes', notes, '--latest'], false);
if (r.status !== 0) process.exit(1);

// Site : lien direct de téléchargement + manifeste signé de mise à jour
const url = `https://github.com/${repo}/releases/latest/download/${NAME}`;
fs.writeFileSync(path.join(root, 'web', 'download.json'), JSON.stringify({ name: NAME, version, size: fs.statSync(ZIP).size, url, repo }, null, 2));
fs.writeFileSync(path.join(root, 'web', '_redirects'), `/download ${url} 302\n`);
fs.copyFileSync(MANIFEST, path.join(root, 'web', 'update.json'));
console.log(`› lien direct : ${url}`);

console.log('› déploiement du site…');
if (node([wr, 'deploy']).status !== 0) process.exit(1);
console.log(`\n✔ Téléchargement direct : https://jarvis.avenox.fr/download\n✔ Mise à jour à distance : https://jarvis.avenox.fr/update.json (v${version})`);
