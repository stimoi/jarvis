// Test de bout en bout : serveur réel + agent réel + faux fournisseur IA.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import { startMockAi } from './mock-ai.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
const PORT = 8790, AI_PORT = 8899;
const TARGET = process.env.E2E_TARGET === 'worker' || process.argv.includes('--worker') ? 'worker' : 'node'; // node = serveur local ; worker = wrangler dev
const base = `http://127.0.0.1:${PORT}`;
const children = [];
let failures = 0;

const env = {
  ...process.env,
  PORT: String(PORT), HOST: '127.0.0.1', JARVIS_DATA_DIR: tmp, JARVIS_AGENT_CONFIG: path.join(tmp, 'agent.json'),
  AI_API_KEY: 'gsk_test', AI_BASE_URL: `http://127.0.0.1:${AI_PORT}`, ALLOW_SIGNUP: 'false', JWT_SECRET: 'e2e-secret',
};
// Ne pas hériter de la vraie clé/config du projet pendant le test.
delete env.XAI_API_KEY;

const step = async (name, fn) => {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body, token, raw) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { ...(raw ? { 'Content-Type': 'audio/wav' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw || JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function waitFor(fn, ms = 15000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timeout : ${what}`);
}

function spawnNode(script, label) {
  const c = spawn(process.execPath, [path.join(root, script)], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = '';
  c.stdout.on('data', (d) => (c.out += d));
  c.stderr.on('data', (d) => (c.out += d));
  c.label = label;
  children.push(c);
  return c;
}

const mock = await startMockAi(AI_PORT);
console.log('\nJARVIS e2e\n');
let token, ws, agentProc, inbox = [];

try {
  if (TARGET === 'worker') {
    // Worker Cloudflare local : wrangler dev (Durable Object + D1 simulés dans un dossier temporaire)
    const wr = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const state = path.join(tmp, 'wrangler-state');
    const wenv = { ...env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
    const mig = spawnSync(process.execPath, [wr, 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--file', path.join(root, 'cloud', 'schema.sql')], { cwd: root, env: wenv, encoding: 'utf8' });
    if (mig.status !== 0) throw new Error(`migration D1 locale : ${mig.stdout}${mig.stderr}`);
    const vars = ['AI_API_KEY:gsk_test', `AI_BASE_URL:http://127.0.0.1:${AI_PORT}`, 'JWT_SECRET:e2e-secret', 'PBKDF2_ITER:2000', 'SETUP_CODE:setup-e2e'].flatMap((v) => ['--var', v]);
    const c = spawn(process.execPath, [wr, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, ...vars], { cwd: root, env: wenv, stdio: ['ignore', 'pipe', 'pipe'] });
    c.out = ''; c.label = 'wrangler';
    c.stdout.on('data', (d) => (c.out += d)); c.stderr.on('data', (d) => (c.out += d));
    children.push(c);
  } else spawnNode('server/index.js', 'server');
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, TARGET === 'worker' ? 90000 : 10000, 'serveur');
  console.log(`  (cible : ${TARGET})`);

  await step('premier compte = admin, mot de passe trop court refusé', async () => {
    assert.equal((await post('/api/register', { username: 'tony', password: 'short' })).status, 400);
    if (TARGET === 'worker') assert.equal((await post('/api/register', { username: 'intrus', password: 'motdepasse-solide', invite: 'mauvais-code' })).status, 403, "code d'installation requis");
    const r = await post('/api/register', { username: 'tony', password: 'motdepasse-solide', invite: 'setup-e2e' });
    assert.equal(r.status, 200); assert.equal(r.json.user.isAdmin, true);
  });
  await step('inscriptions fermées après le premier compte', async () => {
    assert.equal((await post('/api/register', { username: 'pepper', password: 'motdepasse-solide' })).status, 403);
  });
  await step('login OK / mauvais mot de passe refusé', async () => {
    assert.equal((await post('/api/login', { username: 'tony', password: 'mauvais-mdp' })).status, 401);
    const r = await post('/api/login', { username: 'tony', password: 'motdepasse-solide' });
    assert.equal(r.status, 200); token = r.json.token;
  });
  let pepperToken = '';
  const call = async (method, p, tk, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  if (TARGET === 'worker') {
    await step('invitations : création admin, usage unique, non-admin refusé', async () => {
      const inv = await post('/api/invites', {}, token);
      assert.equal(inv.status, 200); assert.match(inv.json.code, /^[A-Z0-9]{8}$/);
      const r1 = await post('/api/register', { username: 'pepper', password: 'motdepasse-solide', invite: inv.json.code });
      assert.equal(r1.status, 200); assert.equal(r1.json.user.isAdmin, false);
      pepperToken = r1.json.token;
      assert.equal((await post('/api/register', { username: 'happy', password: 'motdepasse-solide', invite: inv.json.code })).status, 403, 'code réutilisé');
      assert.equal((await post('/api/invites', {}, r1.json.token)).status, 403, 'non-admin');
    });
    await step('infos du quotidien : emploi du temps -> /api/dash ; réservé à l’admin pour modifier', async () => {
      assert.equal((await call('GET', '/api/info', token)).json.hasIcs, false);
      assert.equal((await call('PUT', '/api/info', pepperToken, { timetable: [] })).status, 403, 'non-admin');
      const tt = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:05', end: '23:55', title: 'Créneau test', place: 'B1' }));
      const put = await call('PUT', '/api/info', token, { timetable: [...tt, { day: 9, start: '1', title: 'invalide' }] });
      assert.equal(put.status, 200); assert.equal(put.json.info.timetable.length, 7, 'créneau invalide écarté');
      assert.equal((await call('PUT', '/api/info', token, { tz: 'Mars/Olympus' })).status, 400);
      assert.equal((await call('PUT', '/api/info', token, { icsUrl: 'http://pas-https.example/cal.ics' })).status, 400, 'ICS en clair refusé');
      const d = (await call('GET', '/api/dash', token)).json;
      assert.equal(d.configured.schedule, true); assert.equal(d.configured.city, false);
      assert.equal(d.schedule.items.filter((i) => i.key === d.schedule.today).length, 1);
      assert.equal(d.schedule.items.length, 2, 'aujourd’hui + demain');
    });
    await step('IA de secours : liste, validation des clés, réservé à l’admin', async () => {
      const p = (await call('GET', '/api/providers', token)).json;
      assert.deepEqual(p.fallbacks.map((f) => f.id), ['mistral', 'gemini', 'openrouter', 'cerebras']);
      assert.ok(p.fallbacks.every((f) => !f.configured));
      assert.equal(p.order[0], 'principal');
      assert.equal((await call('GET', '/api/providers', pepperToken)).status, 403);
      assert.equal((await call('PUT', '/api/providers/mistral', token, { key: 'court' })).status, 400);
      assert.equal((await call('PUT', '/api/providers/inconnu', token, { key: 'x'.repeat(30) })).status, 404);
      assert.equal((await call('DELETE', '/api/providers/mistral', token)).status, 200);
    });
    await step('voix / mail sans PC connecté : erreurs claires', async () => {
      const v = await call('GET', '/api/voices', token);
      assert.equal(v.status, 502); assert.match(v.json.error, /Aucun PC connecté/);
      assert.equal((await call('GET', '/api/mail', token)).json.offline, true);
    });
  }
  await step('routes protégées sans jeton -> 401', async () => {
    assert.equal((await fetch(`${base}/api/history`)).status, 401);
  });

  const dev = (await post('/api/devices', { name: 'PC-test' }, token)).json;
  fs.writeFileSync(env.JARVIS_AGENT_CONFIG, JSON.stringify({ server: base, token: dev.token, deviceId: dev.id, name: 'PC-test', autonomy: 'balanced' }));
  agentProc = spawnNode('agent/index.js', 'agent');

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['jarvis.v1', token]);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const next = (pred, ms = 20000, what = 'message') => waitFor(() => { const i = inbox.findIndex(pred); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, ms, what);
  const chat = (text) => ws.send(JSON.stringify({ type: 'chat', text, via: 'voice', cid: 'e2e' }));

  await step("l'agent PC se connecte et apparaît côté client", async () => {
    const st = await next((m) => m.type === 'state' && m.agents.length === 1, 15000, 'agent en ligne');
    assert.equal(st.agents[0].name, 'PC-test');
  });

  if (TARGET === 'worker') {
    await step('avec un PC : voix (Piper absent ici) et résumé mail passent par l’agent réel', async () => {
      const v = await call('GET', '/api/voices', token);
      assert.equal(v.status, 200); assert.equal(v.json.piper, false); assert.equal(v.json.voices.length, 5);
      assert.equal((await call('POST', '/api/voices', token, { action: 'install', id: '../../x' })).status, 502, 'voix hors catalogue refusée par l’agent');
      assert.deepEqual((await call('GET', '/api/mail', token)).json, { configured: false });
    });
  }

  await step('message simple -> réponse du modèle', async () => {
    chat('bonjour');
    const m = await next((x) => x.type === 'assistant_message');
    assert.match(m.text, /Jarvis/);
    assert.equal(m.origin, 'e2e'); assert.equal(m.via, 'voice');
  });

  await step('outil sûr (get_system_info) exécuté sans validation', async () => {
    chat('donne-moi le systeme');
    const r = await next((x) => x.type === 'tool_result' && x.name === 'get_system_info');
    assert.equal(r.ok, true);
    const m = await next((x) => x.type === 'assistant_message');
    assert.match(m.text, /Hôte/);
    assert.ok(!inbox.some((x) => x.type === 'approval_request'));
  });

  const victim = path.join(os.homedir(), `jarvis-e2e-${Date.now()}.txt`);
  fs.writeFileSync(victim, 'à supprimer');
  await step('suppression -> validation demandée, REFUS -> fichier intact', async () => {
    chat(`supprime ${victim}`);
    const ap = await next((x) => x.type === 'approval_request');
    assert.equal(ap.tool, 'delete_path'); assert.equal(ap.level, 'risky');
    ws.send(JSON.stringify({ type: 'approval', id: ap.id, approved: false }));
    const m = await next((x) => x.type === 'assistant_message');
    assert.match(m.text, /Refusé/);
    assert.ok(fs.existsSync(victim), 'le fichier ne devait pas être supprimé');
  });
  await step('suppression -> ACCEPTÉE -> fichier envoyé à la Corbeille', async () => {
    chat(`supprime ${victim}`);
    const ap = await next((x) => x.type === 'approval_request');
    ws.send(JSON.stringify({ type: 'approval', id: ap.id, approved: true }));
    await next((x) => x.type === 'assistant_message', 30000);
    assert.ok(!fs.existsSync(victim), 'le fichier devait être supprimé');
  });
  await step('commande destructrice -> niveau "danger" + refus', async () => {
    chat('fais un truc danger');
    const ap = await next((x) => x.type === 'approval_request');
    assert.equal(ap.level, 'danger');
    assert.match(ap.summary, /Remove-Item/);
    ws.send(JSON.stringify({ type: 'approval', id: ap.id, approved: false }));
    const m = await next((x) => x.type === 'assistant_message');
    assert.match(m.text, /Refusé/);
  });
  await step('un autre compte ne peut pas répondre à une validation', async () => {
    chat('fais un truc danger');
    const ap = await next((x) => x.type === 'approval_request');
    inbox = inbox.filter((x) => x.type !== 'approval_resolved'); // reliquat de l'étape précédente
    // faux client sans authentification valide
    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['jarvis.v1', 'faux']);
    evil.on('error', () => {});
    await new Promise((r) => { evil.on('open', r); evil.on('close', r); });
    try { evil.send(JSON.stringify({ type: 'approval', id: ap.id, approved: true })); } catch {}
    await sleep(500);
    assert.notEqual(evil.readyState, WebSocket.OPEN, 'un jeton invalide ne doit pas rester connecté');
    assert.ok(!inbox.some((x) => x.type === 'approval_resolved'), 'approbation par un tiers acceptée !');
    ws.send(JSON.stringify({ type: 'approval', id: ap.id, approved: false }));
    await next((x) => x.type === 'assistant_message');
  });
  await step('mémoire (remember) gérée côté serveur', async () => {
    chat('prends note de ça');
    const m = await next((x) => x.type === 'assistant_message');
    assert.match(m.text, /Mémorisé/);
  });
  if (TARGET === 'worker') {
    await step('JARVIS lit l’emploi du temps (get_schedule) et refuse un outil interne (liste blanche)', async () => {
      chat("quel est mon emploi du temps");
      assert.match((await next((x) => x.type === 'assistant_message')).text, /Aujourd'hui : 00:05-23:55 Créneau test/);
      chat('meteo sans ville');
      assert.match((await next((x) => x.type === 'assistant_message')).text, /Aucune ville configurée/);
      chat('utilise un outil interdit');
      assert.match((await next((x) => x.type === 'assistant_message')).text, /outil inconnu \(tts_install\)/);
    });
  }
  await step('mise à jour à distance : version de l’appli, ordre relayé à l’agent, statut relayé (nettoyé) au client', async () => {
    const dev2 = (await post('/api/devices', { name: 'PC-maj' }, token)).json;
    const fake = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['jarvis.v1', dev2.token]);
    const got = [];
    fake.on('message', (d) => { const t = d.toString(); if (t !== 'pong') got.push(JSON.parse(t)); });
    await new Promise((r) => fake.on('open', r));
    fake.send(JSON.stringify({ type: 'hello', info: { name: 'PC-maj', version: '0.4.0', canUpdate: true } }));
    const st = await next((m) => m.type === 'state' && m.agents.some((a) => a.name === 'PC-maj' && a.appVersion === '0.4.0' && a.canUpdate === true), 15000, 'agent PC-maj avec version');
    const id = st.agents.find((a) => a.name === 'PC-maj').id;
    ws.send(JSON.stringify({ type: 'app_cmd', agentId: id, cmd: 'update' }));
    await waitFor(() => got.find((m) => m.type === 'app_cmd' && m.cmd === 'update'), 5000, 'ordre de mise à jour reçu par l’agent');
    ws.send(JSON.stringify({ type: 'app_cmd', agentId: 'inexistant', cmd: 'update' }));
    fake.send(JSON.stringify({ type: 'app_status', state: { phase: 'downloading', current: '0.4.0', latest: '0.4.1', percent: 150, evil: '<script>' } }));
    const s = await next((m) => m.type === 'app_status' && m.agentId === id, 8000, 'statut de mise à jour');
    assert.equal(s.state.phase, 'downloading'); assert.equal(s.state.percent, 100, 'pourcentage non borné');
    assert.ok(!('evil' in s.state), 'champ inconnu transmis');
    await sleep(300);
    assert.equal(got.filter((m) => m.type === 'app_cmd').length, 1, 'ordre envoyé à un agent inexistant');
    fake.close();
    await sleep(200);
    inbox = inbox.filter((m) => m.type !== 'state');
  });
  await step('transcription : /api/stt relaie vers le fournisseur', async () => {
    const r = await post('/api/stt', null, token, Buffer.alloc(4000, 1));
    assert.equal(r.status, 200); assert.match(r.json.text, /Jarvis/);
    assert.ok(mock.calls.some((c) => c.url.endsWith('/audio/transcriptions')));
  });
  await step('Groq : modèle gpt-oss avec reasoning_effort, outils envoyés', async () => {
    const c = mock.calls.find((x) => x.url.endsWith('/chat/completions'));
    assert.equal(c.model, 'openai/gpt-oss-120b'); assert.equal(c.reasoning, 'low'); assert.ok(c.tools > 30);
  });
  await step('journal d\'audit de l\'agent écrit', async () => {
    const log = fs.readFileSync(path.join(tmp, 'agent-audit.log'), 'utf8');
    assert.match(log, /"decision":"denied"/); assert.match(log, /"decision":"approved"/); assert.match(log, /"decision":"auto"/);
  });
  await step('interrupteur PAUSE : l\'agent refuse tout', async () => {
    fs.writeFileSync(path.join(tmp, 'PAUSE'), '');
    chat('donne-moi le systeme');
    const m = await next((x) => x.type === 'assistant_message');
    assert.match(m.text, /suspendu/);
    fs.rmSync(path.join(tmp, 'PAUSE'));
  });
  await step('PWA : page, manifest, sw servis avec CSP', async () => {
    for (const page of ['/', '/auth/', '/chat/']) {
      const r = await fetch(`${base}${page}`);
      assert.equal(r.status, 200, page);
      assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/, `CSP sur ${page}`);
    }
    for (const p of ['/manifest.webmanifest', '/sw.js', '/js/app.js', '/js/wake.js', '/js/reactor.js', '/js/remote.js', '/js/keyboard.js', '/js/auth.js', '/js/landing.js', '/css/hud.css', '/css/chat.css', '/css/landing.css', '/icons/icon.svg']) assert.equal((await fetch(base + p)).status, 200, p);
    assert.equal((await fetch(`${base}/api/downloads`)).status, 200);
  });
} catch (e) {
  failures++;
  console.log('ÉCHEC FATAL :', e.message);
} finally {
  ws?.close();
  children.forEach((c) => { try { c.kill(); } catch {} });
  mock.server.close();
  if (failures) for (const c of children) console.log(`\n--- sortie ${c.label} ---\n${c.out.slice(-1500)}`);
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
  process.exit(failures ? 1 : 0);
}
