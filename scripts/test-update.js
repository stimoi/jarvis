// Test du module de mise à jour (desktop/updater.cjs) : npm run test:update
// Faux serveur local + vraie archive zip + vraies signatures Ed25519 : aucune connexion Internet, rien d'installé.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createUpdater, verifyManifest, payloadOf, gt } = createRequire(import.meta.url)(path.join(root, 'desktop', 'updater.cjs'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-upd-'));

const keys = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');
const pubPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (m, k = keys.privateKey) => ({ ...m, sig: crypto.sign(null, Buffer.from(payloadOf(m)), k).toString('base64') });

// ---- archives de test
function buildZip(version, { omit } = {}) {
  const tag = omit ? omit.replace(/[\\/]/g, '_') : 'ok';
  const dir = path.join(tmp, `src-${version}-${tag}`);
  const files = { 'package.json': JSON.stringify({ name: 'jarvis', version }), 'desktop/main.cjs': '//', 'desktop/preload.cjs': '//', 'agent/index.js': '//', 'shared/tools.js': '//', 'node_modules/ws/package.json': '{}' };
  for (const [f, c] of Object.entries(files)) {
    if (f === omit) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const zip = path.join(tmp, `u-${version}-${tag}.zip`);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'make-zip.ps1'), '-Source', dir, '-Dest', zip], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`zip impossible : ${r.stderr}`);
  return fs.readFileSync(zip);
}
const zips = { '0.5.0': buildZip('0.5.0'), '0.4.0': buildZip('0.4.0'), '0.6.0-incomplete': buildZip('0.6.0', { omit: 'agent/index.js' }) };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let routes = {};
const server = http.createServer((req, res) => {
  const r = routes[req.url];
  if (!r) { res.statusCode = 404; return res.end(); }
  if (typeof r === 'function') return r(req, res);
  res.setHeader('Content-Type', r.type || 'application/json');
  res.end(r.body);
});
await new Promise((r) => server.listen(8897, '127.0.0.1', r));
const base = 'http://127.0.0.1:8897';
const manifestFor = (version, zip, extra = {}) => ({ version, shell: 1, sha256: sha(zip), size: zip.length, url: `${base}/${version}.zip`, notes: 'test', ...extra });

let n = 0;
function make({ current = '0.4.0', urls = [`${base}/update.json`], shellLevel = 1, source = 'bundled' } = {}) {
  const codeDir = path.join(tmp, `code-${++n}`);
  const calls = { relaunch: 0, quit: 0 };
  const states = [];
  const u = createUpdater({ app: { relaunch: () => calls.relaunch++, quit: () => calls.quit++ }, current, source, shellLevel, pubkey: pubPem, codeDir, manifestUrls: urls, log: () => {}, onState: (s) => states.push(s.phase) });
  return { u, codeDir, calls, states };
}

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
console.log('\nMise à jour à distance de l’appli\n');

await test('comparaison de versions', () => {
  assert.ok(gt('0.4.1', '0.4.0') && gt('0.10.0', '0.9.9') && gt('1.0.0', '0.99.99'));
  assert.ok(!gt('0.4.0', '0.4.0') && !gt('0.3.9', '0.4.0'));
});

await test('manifeste : signature valide / falsifié / mauvaise clé', () => {
  const m = sign(manifestFor('0.5.0', zips['0.5.0']));
  assert.ok(verifyManifest(m, pubPem));
  assert.ok(!verifyManifest({ ...m, url: 'https://pirate.example/x.zip' }, pubPem), 'URL falsifiée acceptée');
  assert.ok(!verifyManifest({ ...m, sha256: sha(Buffer.from('autre')) }, pubPem), 'SHA falsifié accepté');
  assert.ok(!verifyManifest({ ...m, version: '9.9.9' }, pubPem), 'version falsifiée acceptée');
  assert.ok(!verifyManifest(sign(manifestFor('0.5.0', zips['0.5.0']), other.privateKey), pubPem), 'mauvaise clé acceptée');
  assert.ok(!verifyManifest({ ...m, sig: undefined }, pubPem) && !verifyManifest(null, pubPem));
});

await test('mise à jour valide : téléchargée, vérifiée, extraite, prête, redémarrage demandé', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0']))) }, '/0.5.0.zip': { body: zips['0.5.0'], type: 'application/zip' } };
  const { u, codeDir, calls, states } = make();
  const st = await u.check({ download: true });
  assert.equal(st.phase, 'ready', st.error); assert.equal(st.latest, '0.5.0');
  assert.ok(states.includes('available') && states.includes('downloading'));
  assert.ok(fs.existsSync(path.join(codeDir, '0.5.0', 'desktop', 'main.cjs')));
  const cur = JSON.parse(fs.readFileSync(path.join(codeDir, 'current.json'), 'utf8'));
  assert.equal(cur.version, '0.5.0'); assert.equal(cur.confirmed, false); assert.equal(cur.tries, 0);
  assert.ok(!fs.readdirSync(codeDir).some((f) => f.startsWith('.dl-') || f.startsWith('.tmp-')), 'fichiers temporaires restants');
  assert.equal(u.apply(), true); assert.deepEqual([calls.relaunch, calls.quit], [1, 1]);
});

await test('manifeste signé avec une autre clé : refusé, rien téléchargé', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0']), other.privateKey)) }, '/0.5.0.zip': { body: zips['0.5.0'] } };
  const { u, codeDir } = make();
  const st = await u.check({ download: true });
  assert.notEqual(st.phase, 'ready'); assert.ok(!fs.existsSync(path.join(codeDir, '0.5.0')));
});

await test('archive modifiée (SHA-256 différent) : refusée', async () => {
  const bad = Buffer.from(zips['0.5.0']); bad[20] ^= 0xff; // un octet modifié, même taille
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0']))) }, '/0.5.0.zip': { body: bad } };
  const { u, codeDir } = make();
  const st = await u.check({ download: true });
  assert.equal(st.phase, 'error'); assert.match(st.error, /SHA-256/);
  assert.ok(!fs.existsSync(path.join(codeDir, '0.5.0')) && !fs.existsSync(path.join(codeDir, 'current.json')));
});

await test('même version ou plus ancienne : à jour (pas de rétrogradation)', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.4.0', zips['0.4.0']))) } };
  assert.equal((await make({ current: '0.4.0' }).u.check({ download: true })).phase, 'uptodate');
  assert.equal((await make({ current: '0.9.0' }).u.check({ download: true })).phase, 'uptodate');
});

await test('version qui exige une coque plus récente : « major », pas de téléchargement', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0'], { shell: 2 }))) }, '/0.5.0.zip': (req, res) => { throw new Error('ne devait pas être téléchargé'); } };
  const { u, codeDir } = make({ shellLevel: 1 });
  const st = await u.check({ download: true });
  assert.equal(st.phase, 'major'); assert.ok(!fs.existsSync(codeDir) || fs.readdirSync(codeDir).length === 0);
});

await test('archive incomplète : refusée', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.6.0', zips['0.6.0-incomplete']))) }, '/0.6.0.zip': { body: zips['0.6.0-incomplete'] } };
  const { u, codeDir } = make();
  const st = await u.check({ download: true });
  assert.equal(st.phase, 'error'); assert.match(st.error, /incomplète/); assert.ok(!fs.existsSync(path.join(codeDir, '0.6.0')));
});

await test('première source en panne : la deuxième est utilisée', async () => {
  routes = { '/a.json': (req, res) => { res.statusCode = 500; res.end(); }, '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0']))) }, '/0.5.0.zip': { body: zips['0.5.0'] } };
  const { u } = make({ urls: [`${base}/a.json`, `${base}/update.json`] });
  { const s = await u.check({ download: true }); assert.equal(s.phase, 'ready', s.error); }
});

await test('sans téléchargement automatique : « available » puis téléchargement à la demande', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0']))) }, '/0.5.0.zip': { body: zips['0.5.0'] } };
  const { u } = make();
  assert.equal((await u.check({ download: false })).phase, 'available');
  assert.equal((await u.downloadLatest()).phase, 'ready');
});

await test('confirmation : la version téléchargée devient « confirmée » et les anciennes sont nettoyées', async () => {
  routes = { '/update.json': { body: JSON.stringify(sign(manifestFor('0.5.0', zips['0.5.0']))) }, '/0.5.0.zip': { body: zips['0.5.0'] } };
  const a = make();
  await a.u.check({ download: true });
  fs.mkdirSync(path.join(a.codeDir, '0.1.0')); // vieux dossier à nettoyer
  const b = createUpdater({ app: {}, current: '0.5.0', source: 'update', shellLevel: 1, pubkey: pubPem, codeDir: a.codeDir, manifestUrls: [], log: () => {} });
  b.confirm();
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.codeDir, 'current.json'), 'utf8')).confirmed, true);
  assert.ok(!fs.existsSync(path.join(a.codeDir, '0.1.0')) && fs.existsSync(path.join(a.codeDir, '0.5.0')));
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
process.exit(failures ? 1 : 0);
