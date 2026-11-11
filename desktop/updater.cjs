'use strict';
// Mises à jour à distance de l'appli de bureau.
//  • Un manifeste signé (Ed25519) annonce la dernière version : { version, shell, sha256, size, url, notes, sig }.
//  • L'archive de mise à jour (≈ 300 Ko : agent, shared, desktop, ws) est téléchargée, vérifiée (SHA-256), extraite
//    dans <profil>/code/<version>, puis l'appli redémarre : boot.cjs lance ce code au lieu du code d'origine.
//  • Rien n'est jamais écrit dans le dossier d'installation (pas de droits administrateur, pas de fichier verrouillé).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const nums = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
/** a > b (versions « x.y.z ») */
function gt(a, b) {
  const x = nums(a), y = nums(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

const payloadOf = (m) => `jarvis-update|${m.version}|${m.shell}|${m.sha256}|${m.size}|${m.url}`;

/** Le manifeste doit être signé avec la clé privée du développeur : site ou GitHub compromis ≠ code exécuté chez les utilisateurs. */
function verifyManifest(m, pubkey) {
  try {
    if (!m || typeof m !== 'object' || !m.sig || !/^\d+\.\d+\.\d+$/.test(String(m.version)) || !/^[a-f0-9]{64}$/.test(String(m.sha256))) return false;
    return crypto.verify(null, Buffer.from(payloadOf(m)), pubkey, Buffer.from(m.sig, 'base64'));
  } catch {
    return false;
  }
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function createUpdater({ app, current, source, shellLevel, pubkey, codeDir, manifestUrls, log = () => {}, onState = () => {} }) {
  const curFile = path.join(codeDir, 'current.json');
  let st = { phase: 'idle', current, latest: null, percent: 0, notes: '', error: '' };
  let manifest = null;
  let busy = null;
  const set = (patch) => { st = { ...st, ...patch }; onState(st); };

  async function fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Cherche la dernière version annoncée. `download` : la télécharge aussitôt si elle est plus récente. */
  async function check({ download = false } = {}) {
    if (busy) return busy;
    busy = (async () => {
      set({ phase: 'checking', error: '' });
      let best = null;
      const errors = [];
      for (const url of manifestUrls) {
        try {
          const m = await fetchJson(url);
          if (!verifyManifest(m, pubkey)) { errors.push(`${url} : signature invalide`); log(`manifeste refusé (signature) : ${url}`); continue; }
          if (!best || gt(m.version, best.version)) best = m;
        } catch (e) { errors.push(`${url} : ${e.message}`); }
      }
      if (!best) { set({ phase: errors.length ? 'error' : 'idle', error: errors.join(' · ') }); log(`recherche sans résultat : ${errors.join(' · ')}`); return st; }
      manifest = best;
      if ((readJson(path.join(codeDir, 'rejected.json')) || []).includes(best.version)) {
        set({ phase: 'uptodate', latest: null, notes: '' });
        log(`version ${best.version} rejetée précédemment (plantage) : ignorée`);
        return st;
      }
      if (!gt(best.version, current)) { set({ phase: 'uptodate', latest: best.version, notes: '' }); log(`à jour (${current})`); return st; }
      if (Number(best.shell) > shellLevel) {
        set({ phase: 'major', latest: best.version, notes: best.notes || '' });
        log(`version ${best.version} nécessite une réinstallation (coque ${best.shell} > ${shellLevel})`);
        return st;
      }
      const staged = readJson(curFile);
      if (staged?.version === best.version && fs.existsSync(path.join(codeDir, best.version, 'desktop', 'main.cjs'))) {
        set({ phase: 'ready', latest: best.version, notes: best.notes || '', percent: 100 });
        return st;
      }
      set({ phase: 'available', latest: best.version, notes: best.notes || '', percent: 0 });
      log(`mise à jour disponible : ${best.version}`);
      if (download) return downloadLatest();
      return st;
    })().catch((e) => { set({ phase: 'error', error: e.message }); log(`erreur : ${e.stack || e.message}`); return st; }).finally(() => { busy = null; });
    return busy;
  }

  /** Télécharge, vérifie et prépare la version annoncée (sans redémarrer). */
  async function downloadLatest() {
    const m = manifest;
    if (!m || !gt(m.version, current)) return st;
    set({ phase: 'downloading', percent: 0, error: '' });
    fs.mkdirSync(codeDir, { recursive: true });
    const zip = path.join(codeDir, `.dl-${m.version}.zip`);
    const tmp = path.join(codeDir, `.tmp-${m.version}`);
    try {
      const res = await fetch(m.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`téléchargement HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(zip);
      let got = 0, lastPct = -1;
      for await (const chunk of res.body) {
        got += chunk.length;
        if (got > Number(m.size) + 1024) throw new Error('archive plus grosse que prévu');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const pct = Math.min(99, Math.floor((got / Number(m.size)) * 100));
        if (pct !== lastPct) { lastPct = pct; set({ percent: pct }); }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      if (got !== Number(m.size)) throw new Error(`taille inattendue (${got} au lieu de ${m.size})`);
      if (hash.digest('hex') !== m.sha256) throw new Error('empreinte SHA-256 incorrecte : mise à jour refusée');

      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      let r = spawnSync('tar', ['-xf', zip, '-C', tmp], { windowsHide: true });
      if (r.status !== 0) { // repli : PowerShell
        r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`], { windowsHide: true });
        if (r.status !== 0) throw new Error('extraction impossible');
      }
      const pkg = readJson(path.join(tmp, 'package.json'));
      for (const f of ['desktop/main.cjs', 'desktop/preload.cjs', 'agent/index.js', 'shared/tools.js', 'node_modules/ws/package.json']) {
        if (!fs.existsSync(path.join(tmp, f))) throw new Error(`archive incomplète (${f} manquant)`);
      }
      if (pkg?.version !== m.version) throw new Error('version de l’archive différente du manifeste');

      const dest = path.join(codeDir, m.version);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      const prev = readJson(curFile);
      fs.writeFileSync(curFile, JSON.stringify({ version: m.version, shell: Number(m.shell) || 1, confirmed: false, tries: 0, previous: prev?.version || null, installedAt: new Date().toISOString() }));
      fs.rmSync(zip, { force: true });
      log(`mise à jour ${m.version} prête (${got} octets, signature et SHA-256 vérifiés)`);
      set({ phase: 'ready', percent: 100 });
    } catch (e) {
      fs.rmSync(zip, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
      log(`échec du téléchargement : ${e.message}`);
      set({ phase: 'error', error: e.message });
    }
    return st;
  }

  /** Redémarre l'appli : boot.cjs lancera la version préparée. L'appelant doit avoir mis ses drapeaux de fermeture. */
  function apply() {
    if (st.phase !== 'ready') return false;
    log(`redémarrage pour installer ${st.latest}`);
    set({ phase: 'restarting' });
    app.relaunch();
    app.quit();
    return true;
  }

  /** Appelé quand le démarrage s'est bien passé : la version devient « confirmée » (sinon retour arrière automatique). */
  function confirm() {
    if (source !== 'update') return;
    const c = readJson(curFile);
    if (c?.version === current && !c.confirmed) {
      fs.writeFileSync(curFile, JSON.stringify({ ...c, confirmed: true, tries: 0 }));
      log(`version ${current} confirmée`);
    }
    // ménage : on garde la version courante et la précédente
    try {
      const keep = new Set([current, c?.previous, c?.version].filter(Boolean));
      for (const d of fs.readdirSync(codeDir, { withFileTypes: true })) if (d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name) && !keep.has(d.name)) fs.rmSync(path.join(codeDir, d.name), { recursive: true, force: true });
    } catch {}
  }

  return { check, downloadLatest, apply, confirm, get state() { return st; } };
}

module.exports = { createUpdater, verifyManifest, payloadOf, gt };
