// Fabrique l'installeur Windows « JARVIS-Setup.exe » (NSIS) à partir du dossier dist/JARVIS produit par `npm run package`.
// Installation par utilisateur (sans droits administrateur) dans %LOCALAPPDATA%\Programs\JARVIS, raccourcis Bureau + menu Démarrer,
// désinstalleur dans « Applications et fonctionnalités », lancement à la fin. Les données (compte, mises à jour) restent à la désinstallation.
// Usage : npm run installer      (après `npm run package`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'electron-builder';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'dist', 'JARVIS');
const out = path.join(root, 'downloads');
if (!fs.existsSync(path.join(appDir, 'JARVIS.exe'))) throw new Error('dist/JARVIS introuvable : lance d’abord `npm run package`.');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
fs.mkdirSync(out, { recursive: true });
fs.rmSync(path.join(out, 'JARVIS-Setup.exe'), { force: true });

await build({
  projectDir: root,
  prepackaged: appDir,
  win: ['nsis'],
  x64: true,
  publish: 'never',
  config: {
    appId: 'fr.avenox.jarvis',
    productName: 'JARVIS',
    copyright: 'JARVIS',
    directories: { output: path.join(root, 'dist', 'installer') },
    extraMetadata: { version },
    compression: 'maximum',
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'JARVIS',
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,
      installerIcon: path.join(root, 'web', 'icons', 'icon.ico'),
      uninstallerIcon: path.join(root, 'web', 'icons', 'icon.ico'),
      artifactName: 'JARVIS-Setup.exe',
    },
    win: { target: 'nsis', icon: path.join(root, 'web', 'icons', 'icon.ico'), signAndEditExecutable: false },
  },
});
const built = path.join(root, 'dist', 'installer', 'JARVIS-Setup.exe');
if (!fs.existsSync(built)) throw new Error('Installeur non généré.');
fs.copyFileSync(built, path.join(out, 'JARVIS-Setup.exe'));
console.log(`› installeur : ${path.join(out, 'JARVIS-Setup.exe')} (${(fs.statSync(built).size / 1e6).toFixed(0)} Mo)`);
