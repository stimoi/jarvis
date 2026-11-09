// Publie l'appli de bureau : Release GitHub (lien de téléchargement direct) + redéploiement du site.
// Le site expose https://jarvis.avenox.fr/download qui redirige vers le dernier zip de la Release GitHub.
// Prérequis : `gh auth login` fait et dépôt GitHub créé (origin).
// Usage : npm run publish:app            (--skip-build pour réutiliser downloads/JARVIS-windows-x64.zip)
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

console.log(`› Release GitHub ${repo} ${tag}…`);
const exists = gh(['release', 'view', tag]).status === 0;
const notes = `JARVIS ${tag} pour Windows 10/11 64 bits. Décompressez l'archive puis lancez JARVIS.exe (voix grave Piper incluse).`;
const r = exists
  ? gh(['release', 'upload', tag, ZIP, '--clobber', '--repo', repo], false)
  : gh(['release', 'create', tag, ZIP, '--repo', repo, '--title', `JARVIS ${tag}`, '--notes', notes, '--latest'], false);
if (r.status !== 0) process.exit(1);

// Lien permanent vers le dernier zip + page d'accueil
const url = `https://github.com/${repo}/releases/latest/download/${NAME}`;
fs.writeFileSync(path.join(root, 'web', 'download.json'), JSON.stringify({ name: NAME, version, size: fs.statSync(ZIP).size, url, repo }, null, 2));
fs.writeFileSync(path.join(root, 'web', '_redirects'), `/download ${url} 302\n`);
console.log(`› lien direct : ${url}`);

console.log('› déploiement du site…');
if (node([wr, 'deploy']).status !== 0) process.exit(1);
console.log(`\n✔ Téléchargement direct : https://jarvis.avenox.fr/download\n  (ou ${url})`);
