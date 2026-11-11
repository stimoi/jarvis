'use strict';
// Point d'entrée de l'appli installée. Ce fichier ne change (presque) jamais : il choisit le code à exécuter.
//  • code d'origine (livré avec l'installation), ou
//  • code plus récent téléchargé par la mise à jour à distance (<profil>/code/<version>), si valide.
// Une version qui plante au démarrage (non « confirmée » après 3 lancements) est supprimée : retour au code précédent.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Niveau de la « coque » (Electron + ce fichier). Une mise à jour qui exige un niveau supérieur demande une réinstallation.
const SHELL_LEVEL = 1;
// Clé publique de signature des mises à jour (la clé privée reste chez le développeur, jamais sur le site ni sur GitHub).
const PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAOezVToNi2OOKtkO7ujxsJp0Mhhxq4VjI6TU/bDZ3HJM=
-----END PUBLIC KEY-----
`;

const nums = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
const gt = (a, b) => { const x = nums(a), y = nums(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const bundledRoot = path.resolve(__dirname, '..');
const bundledVersion = readJson(path.join(bundledRoot, 'package.json'))?.version || '0.0.0';
const codeDir = path.join(app.getPath('userData'), 'code');
const curFile = path.join(codeDir, 'current.json');
const logFile = path.join(app.getPath('userData'), 'updater.log');
const rejFile = path.join(codeDir, 'rejected.json');
const reject = (v) => { try { const r = readJson(rejFile) || []; if (!r.includes(v)) { r.push(v); fs.writeFileSync(rejFile, JSON.stringify(r)); } } catch {} };
const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} [boot] ${m}\n`); } catch {} };

let root = bundledRoot, version = bundledVersion, source = 'bundled';
const cur = readJson(curFile);
if (cur?.version && gt(cur.version, bundledVersion) && (cur.shell || 1) <= SHELL_LEVEL) {
  const dir = path.join(codeDir, cur.version);
  if (fs.existsSync(path.join(dir, 'desktop', 'main.cjs'))) {
    if (!cur.confirmed && (cur.tries || 0) >= 3) {
      log(`version ${cur.version} jamais confirmée après ${cur.tries} lancements : retour arrière`);
      reject(cur.version);
      try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(curFile, { force: true }); } catch {}
    } else {
      if (!cur.confirmed) { try { fs.writeFileSync(curFile, JSON.stringify({ ...cur, tries: (cur.tries || 0) + 1 })); } catch {} }
      root = dir; version = cur.version; source = 'update';
    }
  }
} else if (cur?.version && !gt(cur.version, bundledVersion)) {
  // L'appli réinstallée est au moins aussi récente que le code téléchargé : on repart du code d'origine.
  try { fs.rmSync(path.join(codeDir, cur.version), { recursive: true, force: true }); fs.rmSync(curFile, { force: true }); } catch {}
}

global.__jarvis = { root, version, source, shellLevel: SHELL_LEVEL, pubkey: PUBKEY, codeDir, bundledVersion, logFile };
log(`démarrage du code v${version} (${source}${source === 'update' ? `, d'origine v${bundledVersion}` : ''})`);
try {
  require(path.join(root, 'desktop', 'main.cjs'));
} catch (e) {
  log(`ÉCHEC au chargement de la v${version} : ${e.stack || e.message}`);
  if (source !== 'update') throw e; // le code d'origine lui-même est en cause : on laisse Electron l'afficher
  // Version téléchargée défectueuse : on la supprime et on relance sur le code précédent, sans boîte de dialogue d'erreur.
  reject(version);
  try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(curFile, { force: true }); } catch {}
  log('retour arrière effectué, relance sur le code précédent');
  app.relaunch();
  app.exit(0);
}
