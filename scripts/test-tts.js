// Test de la gestion des voix Piper (catalogue, téléchargement, sélection) contre un faux dépôt local : npm run test:tts
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-'));
const PORT = 8897;
process.env.JARVIS_DATA_DIR = tmp;
process.env.JARVIS_VOICE_BASE = `http://127.0.0.1:${PORT}`;
delete process.env.JARVIS_PIPER_DIR; delete process.env.JARVIS_PIPER_VOICE;
const hits = [];
let truncated = false;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url.endsWith('.onnx.json')) return res.end('{"audio":{"sample_rate":22050}}'.padEnd(600, ' '));
  if (req.url.endsWith('.onnx')) return res.end(Buffer.alloc(truncated ? 1024 : 21 * 1024 * 1024, 7));
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const { ttsVoices, ttsSelect, ttsInstall } = await import('../agent/tts.js');

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
const list = async () => JSON.parse((await ttsVoices()).text);
console.log('\nVoix Piper\n');

await test('catalogue : rien d’installé au départ, voix par défaut Tom', async () => {
  const v = await list();
  assert.equal(v.current, 'fr_FR-tom-medium');
  assert.equal(v.voices.filter((x) => x.installed).length, 0);
});
await test('sélection refusée tant que la voix n’est pas installée', async () => {
  await assert.rejects(ttsSelect({ id: 'fr_FR-siwis-medium' }), /pas installée/);
});
await test('id hors catalogue refusé (aucune URL libre, aucun chemin)', async () => {
  await assert.rejects(ttsInstall({ id: '../../evil' }), /inconnue/);
  assert.deepEqual(hits, []);
});
await test('téléchargement + activation (.onnx.json puis .onnx) dans le dossier utilisateur', async () => {
  const r = await ttsInstall({ id: 'fr_FR-gilles-low' });
  assert.match(r.text, /Gilles/);
  assert.deepEqual(hits, ['/gilles/low/fr_FR-gilles-low.onnx.json', '/gilles/low/fr_FR-gilles-low.onnx']);
  assert.ok(fs.existsSync(path.join(tmp, 'piper', 'voices', 'fr_FR-gilles-low.onnx')));
  assert.ok(!fs.existsSync(path.join(tmp, 'piper', 'voices', 'fr_FR-gilles-low.onnx.part')));
  const v = await list();
  assert.equal(v.current, 'fr_FR-gilles-low');
  assert.ok(v.voices.find((x) => x.id === 'fr_FR-gilles-low').installed);
});
await test('voix à deux locuteurs : Pierre et Jessica partagent le même fichier', async () => {
  hits.length = 0;
  await ttsInstall({ id: 'fr_FR-upmc-medium:1' });
  await ttsInstall({ id: 'fr_FR-upmc-medium:0' }); // déjà là : pas de nouveau téléchargement
  assert.equal(hits.filter((h) => h.endsWith('.onnx')).length, 1);
  assert.equal((await list()).current, 'fr_FR-upmc-medium:0');
});
await test('fichier tronqué : refusé, rien d’activé, pas de reste .part', async () => {
  truncated = true;
  await assert.rejects(ttsInstall({ id: 'fr_FR-siwis-medium' }), /incomplet/);
  assert.ok(!fs.existsSync(path.join(tmp, 'piper', 'voices', 'fr_FR-siwis-medium.onnx')));
  assert.ok(!fs.existsSync(path.join(tmp, 'piper', 'voices', 'fr_FR-siwis-medium.onnx.part')));
  assert.equal((await list()).current, 'fr_FR-upmc-medium:0');
});
await test('changement de voix entre deux voix installées', async () => {
  await ttsSelect({ id: 'fr_FR-gilles-low' });
  assert.equal((await list()).current, 'fr_FR-gilles-low');
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
process.exit(failures ? 1 : 0);
