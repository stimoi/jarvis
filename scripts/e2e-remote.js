// Test de bout en bout du contrôle à distance : VRAIES trames d'écran, VRAI clic et VRAIE frappe.
// ⚠ Pendant ~12 s, une petite fenêtre de test passe au premier plan et la souris est déplacée puis rétablie.
// Usage : node scripts/e2e-remote.js [--worker]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rc-'));
const PORT = 8794;
const base = `http://127.0.0.1:${PORT}`;
const TARGET = process.argv.includes('--worker') ? 'worker' : 'node';
const children = [];
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = async (name, fn) => { try { await fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
const post = async (p, body, token) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
async function waitFor(fn, ms = 15000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timeout : ${what}`);
}

const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', JARVIS_DATA_DIR: tmp, JARVIS_AGENT_CONFIG: path.join(tmp, 'agent.json'), AI_API_KEY: 'gsk_test', JWT_SECRET: 'rc-secret', ALLOW_SIGNUP: 'false', CI: '1', WRANGLER_SEND_METRICS: 'false' };
const spawnNode = (args, label) => {
  const c = spawn(process.execPath, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = ''; c.label = label;
  c.stdout.on('data', (d) => (c.out += d)); c.stderr.on('data', (d) => (c.out += d));
  children.push(c);
  return c;
};

// Fenêtre de test (WinForms, DPI-aware) : affiche son centre en pixels écran, puis le texte reçu et la position finale du curseur.
const FORM_PS = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition 'using System.Runtime.InteropServices; public class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i); [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); }'
[void][D]::SetProcessDPIAware()
$p0 = New-Object System.Drawing.Point; [void][D]::GetCursorPos([ref]$p0)
$f = New-Object System.Windows.Forms.Form; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(300, 250); $f.Size = New-Object System.Drawing.Size(520, 140); $f.TopMost = $true; $f.Text = 'JARVIS e2e'
$t = New-Object System.Windows.Forms.TextBox; $t.Dock = 'Fill'; $t.Font = New-Object System.Drawing.Font('Segoe UI', 20); $f.Controls.Add($t)
$f.Show(); $f.Activate()
for ($i = 0; $i -lt 10; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 30 }
$c = $t.PointToScreen((New-Object System.Drawing.Point([int]($t.Width / 2), [int]($t.Height / 2))))
[Console]::Out.WriteLine('SCREEN:' + [D]::GetSystemMetrics(0) + ',' + [D]::GetSystemMetrics(1))
[Console]::Out.WriteLine('CURSOR0:' + $p0.X + ',' + $p0.Y)
[Console]::Out.WriteLine('TARGET:' + $c.X + ',' + $c.Y)
[Console]::Out.WriteLine('READY')
$end = (Get-Date).AddSeconds(11)
$last = -1
while ((Get-Date) -lt $end) {
  [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20
  $now = [int]([D]::GetForegroundWindow() -eq $f.Handle -and $t.Focused)
  if ($now -ne $last) { $last = $now; [Console]::Out.WriteLine('FOCUS:' + $now) }  # sécurité : Node ne tape QUE si cette fenêtre est au premier plan ET que le champ a le focus
}
$p1 = New-Object System.Drawing.Point; [void][D]::GetCursorPos([ref]$p1)
[Console]::Out.WriteLine('CURPOS:' + $p1.X + ',' + $p1.Y)
[Console]::Out.WriteLine('TEXT:' + $t.Text)
$f.Close()
`;

console.log(`\nJARVIS e2e — contrôle à distance (cible : ${TARGET})\n`);
let ws, formProc;
try {
  if (TARGET === 'worker') {
    const wr = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const state = path.join(tmp, 'wrangler-state');
    const mig = spawnSync(process.execPath, [wr, 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--file', path.join(root, 'cloud', 'schema.sql')], { cwd: root, env, encoding: 'utf8' });
    if (mig.status !== 0) throw new Error(`migration D1 : ${mig.stdout}${mig.stderr}`);
    const vars = ['AI_API_KEY:gsk_test', 'JWT_SECRET:rc-secret', 'PBKDF2_ITER:2000', 'SETUP_CODE:setup-rc'].flatMap((v) => ['--var', v]);
    spawnNode([wr, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state, ...vars], 'wrangler');
  } else spawnNode(['server/index.js'], 'server');
  await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, TARGET === 'worker' ? 90000 : 10000, 'serveur');

  const reg = await post('/api/register', { username: 'tony', password: 'motdepasse-solide', invite: 'setup-rc' });
  const token = reg.json.token;
  const dev = (await post('/api/devices', { name: 'PC-rc' }, token)).json;
  fs.writeFileSync(env.JARVIS_AGENT_CONFIG, JSON.stringify({ server: base, token: dev.token, deviceId: dev.id, name: 'PC-rc' }));
  spawnNode(['agent/index.js'], 'agent');

  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['jarvis.v1', token]);
  const msgs = [];
  let frames = [];
  ws.on('message', (d, isBinary) => (isBinary ? frames.push(Buffer.from(d)) : msgs.push(JSON.parse(d.toString()))));
  await new Promise((r) => ws.on('open', r));
  const next = (pred, ms = 20000, what = 'message') => waitFor(() => { const i = msgs.findIndex(pred); return i >= 0 ? msgs.splice(i, 1)[0] : null; }, ms, what);
  const sendJ = (m) => ws.send(JSON.stringify(m));
  const st = await next((m) => m.type === 'state' && m.agents.length === 1, 20000, 'agent en ligne');
  const agentId = st.agents[0].id;

  await step('rc_start : trames JPEG binaires reçues (préfixe 0x01 + FFD8)', async () => {
    sendJ({ type: 'rc_start', agentId, opts: { fps: 6, w: 900, q: 50 } });
    await next((m) => m.type === 'rc_started');
    await waitFor(() => frames.length >= 3, 15000, 'trames');
    const f = frames[0];
    assert.equal(f[0], 1); assert.equal(f[1], 0xff); assert.equal(f[2], 0xd8);
    assert.ok(f.length > 2000, `trame trop petite (${f.length})`);
  });

  await step('fenêtre de test : clic à distance (souris) + saisie (accents) + raccourci Maj+Début', async () => {
    const lines = [];
    formProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FORM_PS], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    formProc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
    const get = (k) => lines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1);
    await waitFor(() => lines.includes('READY'), 20000, 'fenêtre de test prête');
    const [W, H] = get('SCREEN').split(',').map(Number);
    const [tx, ty] = get('TARGET').split(',').map(Number);
    const [cx0, cy0] = get('CURSOR0').split(',').map(Number);
    const click = (nx, ny) => { sendJ({ type: 'rc_input', ev: { k: 'm', x: nx, y: ny } }); sendJ({ type: 'rc_input', ev: { k: 'd', b: 'l' } }); sendJ({ type: 'rc_input', ev: { k: 'u', b: 'l' } }); };
    click(tx / W, ty / H);
    await sleep(500);
    // Sécurité : si la fenêtre de test n'a pas le focus (l'utilisateur utilise son PC), on NE TAPE RIEN (la frappe partirait ailleurs).
    const focus = () => lines.filter((l) => l.startsWith('FOCUS:')).pop();
    await sleep(300);
    await waitFor(() => focus(), 3000, 'état du focus');
    if (focus() !== 'FOCUS:1') throw new Error("la fenêtre de test n'est pas au premier plan (autre fenêtre par-dessus, poste utilisé en même temps ?) : saisie NON envoyée, test à relancer sans toucher au PC");
    sendJ({ type: 'rc_input', ev: { k: 't', text: 'héllo wörld' } });
    await sleep(700);
    sendJ({ type: 'rc_input', ev: { k: 'p', keys: 'shift+home' } }); // sélection jusqu'au début (le TextBox WinForms n'a pas de Ctrl+A)
    await sleep(300);
    sendJ({ type: 'rc_input', ev: { k: 't', text: 'ok é' } });
    await sleep(500);
    // position du curseur à l'instant du clic : on la lit juste avant de rétablir l'ancienne
    sendJ({ type: 'rc_input', ev: { k: 'm', x: cx0 / W, y: cy0 / H } }); // curseur rétabli là où il était
    await waitFor(() => get('TEXT') !== undefined, 20000, 'résultat de la fenêtre');
    // Le texte reçu prouve que le clic est tombé dans la zone de saisie (donc que le placement de la souris est exact).
    // La position finale du curseur n'est volontairement pas vérifiée : l'utilisateur peut bouger sa vraie souris pendant le test.
    assert.equal(get('TEXT'), 'ok é', `texte reçu : « ${get('TEXT')} »`);
  });

  await step('rc_stop : les trames s’arrêtent', async () => {
    sendJ({ type: 'rc_stop' });
    await sleep(800);
    frames = [];
    await sleep(2000);
    assert.ok(frames.length <= 1, `${frames.length} trames reçues après l'arrêt`);
  });

  await step('PAUSE : le contrôle à distance est refusé', async () => {
    fs.writeFileSync(path.join(tmp, 'PAUSE'), '');
    sendJ({ type: 'rc_start', agentId, opts: {} });
    const err = await next((m) => m.type === 'rc_error', 10000, 'rc_error');
    assert.match(err.message, /suspendu|PAUSE/i);
    sendJ({ type: 'rc_stop' });
    fs.rmSync(path.join(tmp, 'PAUSE'));
  });

  await step('agent inconnu : rc_start refusé', async () => {
    sendJ({ type: 'rc_start', agentId: 'inexistant' });
    const err = await next((m) => m.type === 'rc_error');
    assert.match(err.message, /pas connecté/);
  });

  await step('journal d’audit : début/fin de session distants', async () => {
    const log = fs.readFileSync(path.join(tmp, 'agent-audit.log'), 'utf8');
    assert.match(log, /"tool":"remote","decision":"start"/); assert.match(log, /"tool":"remote","decision":"stop"/);
  });
} catch (e) {
  failures++;
  console.log('ÉCHEC FATAL :', e.message);
} finally {
  ws?.close();
  try { formProc?.kill(); } catch {}
  children.forEach((c) => { try { c.kill(); } catch {} });
  if (failures) for (const c of children) console.log(`\n--- sortie ${c.label} ---\n${c.out.slice(-1200)}`);
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
  process.exit(failures ? 1 : 0);
}
