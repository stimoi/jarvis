// Test de bout en bout de la mise à jour à distance, avec la VRAIE appli empaquetée (dist/JARVIS/JARVIS.exe) :
// nécessite `npm run package` au préalable. Aucun serveur de production n'est touché : manifeste et archives viennent d'un serveur local,
// signés avec la vraie clé (data/update-key.pem). Le profil de l'appli est isolé (--user-data-dir), la tienne n'est pas modifiée.
//   A. mise à jour valide        : l'appli détecte, télécharge, vérifie, redémarre et tourne sur la nouvelle version
//   B. version qui plante        : retour arrière automatique sur la version précédente, et la version fautive n'est plus réinstallée
//   C. version jamais confirmée  : abandonnée après 3 lancements sans succès
//   D. manifeste mal signé       : ignoré, l'appli reste telle quelle
// Usage : node scripts/e2e-update.js        (⚠ ouvre/masque brièvement l'appli ; ~2 min)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'dist', 'JARVIS', 'JARVIS.exe');
const stage = path.join(root, 'dist', 'stage');
if (!fs.existsSync(exe) || !fs.existsSync(stage)) throw new Error("Lance d'abord « npm run package » (dist/JARVIS/JARVIS.exe et dist/stage requis).");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2eupd-'));
const PORT = 8895;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundled = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version;
const bump = (v) => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}`; };
const V_OK = bump(bundled), V_BAD = bump(V_OK);

// ---- prépare les mises à jour (copie du dossier de l'appli + version changée), signées avec la vraie clé
function makeUpdate(version, serveDir, mutate) {
  const dir = path.join(tmp, `stage-${version}`);
  fs.cpSync(stage, dir, { recursive: true });
  const pkgFile = path.join(dir, 'package.json');
  fs.writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf8')), version }, null, 2));
  mutate?.(dir);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'make-update.js'), '--stage', dir, '--out', serveDir, '--url-base', base, '--notes', 'test e2e'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make-update : ${r.stdout}${r.stderr}`);
}
const serveOk = path.join(tmp, 'serve-ok'), serveBad = path.join(tmp, 'serve-bad'), serveSig = path.join(tmp, 'serve-sig');
makeUpdate(V_OK, serveOk);
makeUpdate(V_BAD, serveBad, (d) => fs.writeFileSync(path.join(d, 'desktop', 'main.cjs'), "throw new Error('mise à jour volontairement cassée');\n"));
makeUpdate(V_OK, serveSig);
{ // manifeste dont on change la version après signature
  const f = path.join(serveSig, 'update.json');
  const m = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...m, version: bump(V_BAD) }));
}

let serving = serveOk;
const server = http.createServer((req, res) => {
  const f = path.join(serving, decodeURIComponent(req.url.slice(1)));
  if (!f.startsWith(serving) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const procs = [];
function launch(name, extraEnv = {}) {
  const ud = path.join(tmp, `ud-${name}`), data = path.join(tmp, `data-${name}`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, '.first-run'), 'x'); // pas d'entrée de démarrage Windows pour ce test
  const p = spawn(exe, [`--user-data-dir=${ud}`, '--hidden'], {
    env: { ...process.env, JARVIS_DATA_DIR: data, JARVIS_SERVER: 'http://127.0.0.1:9', JARVIS_UPDATE_URL: `${base}/update.json`, JARVIS_UPDATE_FIRST_MS: '2500', JARVIS_UPDATE_CONFIRM_MS: '3000', ...extraEnv },
    stdio: 'ignore',
  });
  procs.push(p);
  return { p, ud, log: () => { try { return fs.readFileSync(path.join(ud, 'updater.log'), 'utf8'); } catch { return ''; } }, cur: () => { try { return JSON.parse(fs.readFileSync(path.join(ud, 'code', 'current.json'), 'utf8')); } catch { return null; } } };
}
// Après une mise à jour, l'appli relancée n'est plus un enfant du processus d'origine : on l'arrête par son profil isolé de test
// (la ligne de commande contient --user-data-dir=<dossier de test>) ; ta vraie appli JARVIS n'est jamais concernée.
const killProfile = (name) => {
  const needle = (name ? path.join(tmp, `ud-${name}`) : tmp).replace(/'/g, "''");
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='JARVIS.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`], { windowsHide: true });
};
const kill = (p, name) => { killProfile(name); try { spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch {} };
async function waitFor(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(300); } throw new Error(`timeout : ${what}`); }

let failures = 0;
const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
console.log(`\nMise à jour à distance — appli empaquetée v${bundled} (mise à jour de test : v${V_OK}, version cassée : v${V_BAD})\n`);

try {
  await step(`A. mise à jour valide : v${bundled} -> v${V_OK} (téléchargement, vérification, redémarrage automatique)`, async () => {
    serving = serveOk;
    const a = launch('A', { JARVIS_UPDATE_AUTOAPPLY: '1' });
    await waitFor(() => a.log().includes(`démarrage du code v${V_OK} (update`), 90000, `redémarrage sur la v${V_OK}\n${a.log()}`);
    const log = a.log();
    for (const frag of [`démarrage du code v${bundled} (bundled)`, `mise à jour disponible : ${V_OK}`, `mise à jour ${V_OK} prête`, `redémarrage pour installer ${V_OK}`]) assert.ok(log.includes(frag), `journal sans « ${frag} »\n${log}`);
    await waitFor(() => a.cur()?.confirmed === true, 30000, 'version confirmée');
    assert.equal(a.cur().version, V_OK);
    kill(a.p, 'A');
    await sleep(1500);
    kill(a.p, 'A');
  });

  await step(`A2. relance suivante : l'appli démarre directement sur la v${V_OK} (sans nouveau téléchargement)`, async () => {
    const ud = path.join(tmp, 'ud-A');
    const a2 = launch('A', {});
    await waitFor(() => (a2.log().match(new RegExp(`démarrage du code v${V_OK} \\(update`, 'g')) || []).length >= 2, 40000, 'second démarrage sur la v' + V_OK);
    await waitFor(() => a2.log().includes(`à jour (${V_OK})`), 40000, 'recherche : à jour');
    kill(a2.p, 'A');
    assert.ok(ud);
  });

  await step(`B. version qui plante : retour arrière immédiat sur la v${bundled}, et elle n'est plus proposée`, async () => {
    serving = serveBad;
    const b = launch('B', { JARVIS_UPDATE_AUTOAPPLY: '1' });
    await waitFor(() => b.log().includes('retour arrière effectué'), 90000, `retour arrière\n${b.log()}`);
    await waitFor(() => (b.log().match(new RegExp(`démarrage du code v${bundled} \\(bundled\\)`, 'g')) || []).length >= 2, 40000, `relance sur la v${bundled}`);
    await waitFor(() => b.log().includes('rejetée précédemment'), 40000, 'version fautive ignorée');
    assert.ok(!fs.existsSync(path.join(b.ud, 'code', V_BAD)), 'dossier de la version cassée non supprimé');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.ud, 'code', 'rejected.json'), 'utf8')), [V_BAD]);
    kill(b.p, 'B');
  });

  await step('C. version jamais confirmée après 3 lancements : abandonnée', async () => {
    const ud = path.join(tmp, 'ud-C', 'code');
    const dir = path.join(ud, V_OK);
    fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: V_OK }));
    fs.writeFileSync(path.join(dir, 'desktop', 'main.cjs'), "setTimeout(() => process.exit(1), 100);\n"); // « plante » juste après le démarrage
    fs.writeFileSync(path.join(ud, 'current.json'), JSON.stringify({ version: V_OK, shell: 1, confirmed: false, tries: 3 }));
    serving = serveSig; // aucune mise à jour valide proposée
    const c = launch('C', {});
    await waitFor(() => c.log().includes('jamais confirmée après 3 lancements : retour arrière'), 40000, `retour arrière (tries)\n${c.log()}`);
    await waitFor(() => c.log().includes(`démarrage du code v${bundled} (bundled)`), 40000, 'retour sur le code d\'origine');
    assert.ok(!fs.existsSync(dir));
    kill(c.p, 'C');
  });

  await step('D. manifeste mal signé : ignoré, rien n’est installé', async () => {
    serving = serveSig;
    const d = launch('D', { JARVIS_UPDATE_AUTOAPPLY: '1' });
    await waitFor(() => d.log().includes('signature'), 60000, `refus de signature\n${d.log()}`);
    await sleep(2500);
    assert.ok(!d.log().includes('mise à jour disponible'), 'manifeste falsifié accepté !');
    assert.ok(!fs.existsSync(path.join(d.ud, 'code', 'current.json')));
    kill(d.p, 'D');
  });
} catch (e) {
  failures++;
  console.log('ÉCHEC FATAL :', e.message);
} finally {
  procs.forEach((p) => kill(p));
  server.close();
  await sleep(1500);
  killProfile();
  await sleep(1000);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
  process.exit(failures ? 1 : 0);
}
