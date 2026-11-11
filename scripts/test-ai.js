// Test de la chaîne de modèles (shared/ai.js) contre un faux fournisseur local : npm run test:ai
import http from 'node:http';
import assert from 'node:assert/strict';
import { chat, _resetAiState, AiError } from '../shared/ai.js';

const PORT = 8898;
let behaviors = {}; // modèle -> (res) => void
let live = null; // liste renvoyée par /models (null = endpoint en échec)
let calls = [];

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/models')) {
    if (!live) { res.statusCode = 500; return res.end('{}'); }
    return res.end(JSON.stringify({ data: live.map((id) => ({ id, active: true })) }));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push(body.model);
  (behaviors[body.model] || ((r) => { r.statusCode = 500; r.end('{}'); }))(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const ok = (content = 'ok') => (res) => res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
const rate = (text, retry) => (res) => { res.statusCode = 429; if (retry) res.setHeader('retry-after', String(retry)); res.end(JSON.stringify({ error: { message: text } })); };
const gone = () => (res) => { res.statusCode = 404; res.end(JSON.stringify({ error: { message: 'The model does not exist', code: 'model_not_found' } })); };

const ai = { provider: 'groq', key: 'k', baseUrl: `http://127.0.0.1:${PORT}`, chatModel: 'org/m-main', fallbackModels: ['m-gone', 'm-small'], visionModel: 'm-vis' };
const ask = (messages = [{ role: 'user', content: 'salut' }]) => chat(ai, { messages });
const reset = () => { _resetAiState(); calls = []; };
let failures = 0;
const test = async (name, fn) => { try { reset(); await fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); } };

console.log('\nChaîne de modèles IA\n');

await test('modèle disparu (absent de /models) : jamais appelé', async () => {
  live = ['org/m-main', 'm-small', 'm-vis']; behaviors = { 'org/m-main': ok('principal'), 'm-small': ok('petit') };
  assert.equal((await ask()).content, 'principal');
  assert.deepEqual(calls, ['org/m-main']);
});

await test('quota atteint : repli, puis le modèle reste en pause (pas de nouvel appel)', async () => {
  live = ['org/m-main', 'm-small']; behaviors = { 'org/m-main': rate('Rate limit', 30), 'm-small': ok('petit') };
  assert.equal((await ask()).content, 'petit');
  assert.equal((await ask()).content, 'petit');
  assert.deepEqual(calls, ['org/m-main', 'm-small', 'm-small']);
});

await test('/models en échec : on essaie quand même la chaîne ; un 404 écarte le modèle', async () => {
  live = null; behaviors = { 'org/m-main': gone(), 'm-gone': gone(), 'm-small': ok('petit') };
  assert.equal((await ask()).content, 'petit');
  calls = [];
  assert.equal((await ask()).content, 'petit');
  assert.deepEqual(calls, ['m-small'], 'les modèles introuvables ne sont plus appelés');
});

await test('tout en quota : message clair avec l’heure de reprise (Retry-After du texte)', async () => {
  live = ['org/m-main', 'm-small'];
  behaviors = { 'org/m-main': rate('Please try again in 7m12.5s.'), 'm-small': rate('Please try again in 3m1s.') };
  await assert.rejects(ask(), (e) => e instanceof AiError && e.status === 429 && /Quota gratuit atteint sur tous les fournisseurs IA \(groq\)/.test(e.message) && /3 min|4 min/.test(e.message), 'message de quota attendu');
  calls = [];
  await assert.rejects(ask()); // 2e demande : aucun appel inutile pendant la pause
  assert.deepEqual(calls, []);
});

await test('mélange quota + modèle absent : les deux causes sont expliquées', async () => {
  live = null; behaviors = { 'org/m-main': rate('x', 600), 'm-gone': gone(), 'm-small': gone() };
  await assert.rejects(ask(), (e) => /quota atteint/.test(e.message) && /modèle indisponible/.test(e.message));
});

await test('balises <think> du raisonnement retirées', async () => {
  live = ['org/m-main']; behaviors = { 'org/m-main': ok('<think>je réfléchis</think>Bonjour') };
  assert.equal((await ask()).content, 'Bonjour');
});

await test('image : seul le modèle vision est utilisé', async () => {
  live = ['org/m-main', 'm-vis']; behaviors = { 'org/m-main': ok('texte'), 'm-vis': ok('vu') };
  const r = await ask([{ role: 'user', content: [{ type: 'text', text: 'ça ?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
  assert.equal(r.content, 'vu');
  assert.deepEqual(calls, ['m-vis']);
});

await test('clé refusée (401) : erreur immédiate', async () => {
  live = ['org/m-main']; behaviors = { 'org/m-main': (res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad key' } })); } };
  await assert.rejects(ask(), (e) => e.status === 401 && /refusée/.test(e.message));
});

const ai2 = { provider: 'mistral', key: 'k2', baseUrl: `http://127.0.0.1:${PORT}/b`, chatModel: 'b-main', fallbackModels: [], visionModel: '' };
const run = { provider: 'cf', chatModel: '@cf/x/big', fallbackModels: ['@cf/x/small'], visionModel: '', run: async (model, body) => { calls.push(model); return runBehavior(model, body); } };
let runBehavior = () => ({ choices: [{ message: { role: 'assistant', content: 'cf' } }] });

await test('fournisseur principal en quota : le secours répond, puis le principal reste en pause', async () => {
  live = ['org/m-main', 'm-small', 'b-main']; behaviors = { 'org/m-main': rate('x', 600), 'm-small': rate('x', 600), 'b-main': ok('secours') };
  const r = await chat([ai, ai2], { messages: [{ role: 'user', content: 'a' }] });
  assert.equal(r.content, 'secours');
  assert.equal(r.via, 'mistral/b-main');
  calls = [];
  assert.equal((await chat([ai, ai2], { messages: [{ role: 'user', content: 'a' }] })).content, 'secours');
  assert.deepEqual(calls, ['b-main'], 'principal non rappelé pendant sa pause');
});

await test('clé du principal refusée : le secours prend le relais', async () => {
  live = ['org/m-main', 'b-main']; behaviors = { 'org/m-main': (res) => { res.statusCode = 401; res.end('{}'); }, 'b-main': ok('secours') };
  assert.equal((await chat([ai, ai2], { messages: [{ role: 'user', content: 'a' }] })).content, 'secours');
});

await test('Workers AI (run) en dernier recours + arguments d’outil {"": {}} normalisés', async () => {
  live = ['org/m-main', 'm-small']; behaviors = { 'org/m-main': rate('x', 600), 'm-small': rate('x', 600) };
  runBehavior = () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_system_info', arguments: '{"": {}}' } }] } }] });
  const r = await chat([ai, run], { messages: [{ role: 'user', content: 'a' }], tools: [{ type: 'function', function: { name: 'get_system_info', parameters: { type: 'object', properties: {} } } }] });
  assert.equal(r.tool_calls[0].function.name, 'get_system_info');
  assert.equal(r.tool_calls[0].function.arguments, '{}');
  assert.equal(r.via, 'cf/big');
});

await test('Workers AI : quota quotidien -> pause jusqu’à minuit UTC, message clair', async () => {
  live = ['org/m-main', 'm-small']; behaviors = { 'org/m-main': rate('x', 600), 'm-small': rate('x', 600) };
  runBehavior = () => { throw new Error('daily free allocation of 10,000 neurons exceeded'); };
  await assert.rejects(chat([ai, run], { messages: [{ role: 'user', content: 'a' }] }), (e) => e.status === 429 && /tous les fournisseurs IA \(groq, cf\)/.test(e.message));
  calls = [];
  await assert.rejects(chat([ai, run], { messages: [{ role: 'user', content: 'a' }] }));
  assert.deepEqual(calls, []);
});

server.close();
console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
process.exit(failures ? 1 : 0);
