import { VoiceInput, findWake, isHallucination } from './wake.js';
import { mountReactor } from './reactor.js';
import { createRemote } from './remote.js';

const $ = (s) => document.querySelector(s);
const desktop = window.jarvisDesktop || null; // fourni par l'appli de bureau (Electron)

// ---------------------------------------------------------------- état
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const S = {
  token: store.get('jv-token', null),
  user: null,
  ws: null,
  cid: Math.random().toString(36).slice(2, 10),
  agents: [],
  busy: false,
  voiceMode: 'off', // off | passive | listening
  phase: 'idle', // idle | thinking | speaking
  prefs: { speak: true, speakAll: false, follow: false, voiceOk: false, debug: false, depth: 0.86, ...store.get('jv-prefs', {}) },
  approvals: [],
  stats: { cpu: [], ram: [] },
  appStatus: {}, // état des mises à jour de l'appli de bureau, par PC
  connAt: {}, // date de dernière connexion de chaque PC (pour repérer une reconnexion)
};

// v0.5.2 : après une réponse, JARVIS ne se réactive plus tout seul (il faut redire « Jarvis ») ; le mode conversation reste activable.
if (store.get('jv-prefs-v', 1) < 2) { S.prefs.follow = false; store.set('jv-prefs', S.prefs); store.set('jv-prefs-v', 2); }

if (!S.token) location.replace(`/auth/?next=${encodeURIComponent(location.pathname)}`);

// ---------------------------------------------------------------- utilitaires
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = raw.type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401 && S.token) { logout(); throw new Error('Session expirée'); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const e = new Error(j.error || `Erreur ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res;
}
const json = async (path, opts) => (await api(path, opts)).json();

function addMsg(kind, text) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.textContent = text;
  $('#log').append(d);
  scroll();
  return d;
}
function scroll() { const l = $('#log'); l.scrollTop = l.scrollHeight; }
const toolEls = new Map();
const fmtBytes = (n) => (n >= 1e12 ? `${(n / 1e12).toFixed(1)} To` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} Go` : `${Math.round(n / 1e6)} Mo`);
const fmtUp = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min`; };

// ---------------------------------------------------------------- réacteur / état
mountReactor($('#orb'));
const meter = $('#meter');
meter.innerHTML = '<i></i>'.repeat(18);
const meterBars = [...meter.children];

function render() {
  const cls = S.phase !== 'idle' ? S.phase : S.voiceMode;
  $('#orb').className = `reactor ${cls}`;
  const labels = {
    off: 'Micro désactivé', passive: 'En veille — dites « Jarvis »', listening: 'Je vous écoute…',
    thinking: 'Je réfléchis…', speaking: 'Je parle…',
  };
  $('#state-label').textContent = labels[cls];
  $('#btn-mic').classList.toggle('on', S.voiceMode !== 'off');
  $('#btn-stop').hidden = !(S.phase !== 'idle' || S.busy);
  $('#meter-text').textContent = S.voiceMode === 'off' ? 'Micro coupé' : S.voiceMode === 'listening' ? 'Écoute de votre ordre' : 'Veille — mot d\'activation « Jarvis »';
  const agent = S.agents[S.agents.length - 1];
  $('#agent-chip').classList.toggle('online', !!agent);
  $('#agent-name').textContent = agent ? agent.name : 'Aucun PC connecté';
  $('#btn-remote').hidden = !agent;
  $('#pc-name').textContent = agent?.name || '—';
  $('#pc-os').textContent = agent?.os || '—';
  $('#pc-user').textContent = agent?.user || '—';
  $('#pc-voice').textContent = agent ? (agent.tts ? 'Piper (grave)' : 'Navigateur') : '—';
  renderPcApp();
}
function setPhase(p) { S.phase = p; render(); }
function setVoice(m) { S.voiceMode = m; render(); }

function onLevel(v) {
  const l = Math.min(1, v * 6);
  document.documentElement.style.setProperty('--level', l.toFixed(3));
  const lit = Math.round(l * meterBars.length);
  meterBars.forEach((b, i) => {
    b.classList.toggle('on', i < lit);
    b.style.height = `${12 + Math.min(88, (i < lit ? 40 + (i / meterBars.length) * 60 : 0))}%`;
  });
}

// ---------------------------------------------------------------- horloge + graphiques
function tickClock() {
  const d = new Date();
  $('#clock-time').textContent = d.toLocaleTimeString('fr-FR');
  $('#clock-date').textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
setInterval(tickClock, 1000);
tickClock();

function drawGraph(canvas, data) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(26,155,255,.18)';
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (h * i) / 4); g.lineTo(w, (h * i) / 4); g.stroke(); }
  if (data.length < 2) return;
  const step = w / 59;
  const pts = data.map((v, i) => [w - (data.length - 1 - i) * step, h - (Math.max(0, Math.min(100, v)) / 100) * (h - 3) - 1.5]);
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(61,230,255,.5)'); grad.addColorStop(1, 'rgba(26,155,255,.02)');
  g.beginPath(); g.moveTo(pts[0][0], h);
  pts.forEach(([x, y]) => g.lineTo(x, y));
  g.lineTo(pts[pts.length - 1][0], h); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = '#3de6ff'; g.lineWidth = 1.6; g.shadowColor = '#3de6ff'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
}

function onStats(st) {
  const ramPct = Math.round((st.ramUsed / st.ramTotal) * 100);
  const push = (a, v) => { a.push(v); if (a.length > 60) a.shift(); };
  push(S.stats.cpu, st.cpu); push(S.stats.ram, ramPct);
  $('#cpu-num').textContent = st.cpu; $('#ram-num').textContent = ramPct;
  $('#cpu-cores').textContent = `${st.cores}`; $('#cpu-model').textContent = (st.cpuModel || '—').replace(/\(R\)|\(TM\)|CPU|Processor/g, '').replace(/\s+/g, ' ').trim();
  $('#ram-detail').textContent = `${fmtBytes(st.ramUsed)} / ${fmtBytes(st.ramTotal)}`;
  $('#pc-uptime').textContent = fmtUp(st.uptime);
  drawGraph($('#g-cpu'), S.stats.cpu); drawGraph($('#g-ram'), S.stats.ram);
  const el = $('#disks');
  el.innerHTML = '';
  for (const d of st.disks || []) {
    const used = d.total - d.free;
    const div = document.createElement('div');
    div.className = 'disk';
    div.innerHTML = '<div class="row1"><span></span><span class="mono"></span></div><div class="bar"><i></i></div>';
    div.querySelector('span').textContent = `Disque ${d.name}`;
    div.querySelector('.mono').textContent = `${fmtBytes(used)} / ${fmtBytes(d.total)}`;
    div.querySelector('i').style.width = `${Math.round((used / d.total) * 100)}%`;
    el.append(div);
  }
}

function activity(id, name, text, cls) {
  const ul = $('#activity');
  if (ul.querySelector('.muted')) ul.innerHTML = '';
  let li = id && ul.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!li) {
    li = document.createElement('li');
    li.dataset.id = id || '';
    li.innerHTML = '<span></span><span></span>';
    ul.prepend(li);
    while (ul.children.length > 9) ul.lastChild.remove();
  }
  li.firstChild.className = cls;
  li.firstChild.textContent = cls === 'ok' ? '✔' : cls === 'fail' ? '✘' : '⚙';
  li.lastChild.textContent = `${name} ${text || ''}`;
}

// ---------------------------------------------------------------- voix : synthèse (voix grave façon JARVIS)
let actx = null;
const audioCtx = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());
function beep(freq = 880, dur = 0.12, vol = 0.05) {
  try {
    const ctx = audioCtx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq; g.gain.value = vol;
    o.connect(g).connect(ctx.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur); o.stop(ctx.currentTime + dur);
  } catch {}
}

let impulse = null;
function reverbImpulse(ctx) {
  if (impulse) return impulse;
  const len = Math.floor(ctx.sampleRate * 0.32);
  impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = impulse.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return impulse;
}

let currentSource = null;
/** Lit la voix Piper en la ralentissant légèrement (hauteur plus grave) avec graves renforcés et réverbération discrète. */
async function playDeep(arrayBuffer) {
  const ctx = audioCtx();
  await ctx.resume();
  const buf = await ctx.decodeAudioData(arrayBuffer);
  await new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = S.prefs.depth;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 220; low.gain.value = 5;
    const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 2600; pres.Q.value = 0.8; pres.gain.value = -2;
    const master = ctx.createGain(); master.gain.value = 0.85;
    const wet = ctx.createGain(); wet.gain.value = 0.15;
    const conv = ctx.createConvolver(); conv.buffer = reverbImpulse(ctx);
    src.connect(low).connect(pres);
    pres.connect(master); pres.connect(conv); conv.connect(wet).connect(master);
    master.connect(ctx.destination);
    currentSource = src;
    src.onended = () => { currentSource = null; setTimeout(resolve, 180); };
    src.start();
  });
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const voices = speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('fr'));
    const male = voices.find((v) => /(paul|henri|claude|antoine|thomas|mathieu|r[eé]my|guillaume|nicolas|male|homme)/i.test(v.name));
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.voice = male || voices[0] || null;
    u.pitch = male ? 0.75 : 0.45; // le plus grave possible quand aucune voix masculine n'est installée
    u.rate = 0.95;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

const clean = (t) => t.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' lien ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

// Le micro reste ouvert pendant que JARVIS parle (annulation d'écho du navigateur) : dire « Jarvis… » lui coupe la parole.
// `spokenText` sert à ignorer ce que le micro capte de sa propre voix.
let spokenText = '';
let speakSeq = 0; // chaque nouvelle phrase / interruption invalide les lectures en cours
async function speak(text) {
  const t = clean(text).slice(0, 1200);
  if (!t) return;
  const seq = ++speakSeq;
  spokenText = t;
  voice?.setQuick(true);
  setPhase('speaking');
  try {
    if (S.agents.some((a) => a.tts)) {
      try {
        const ab = await (await api('/api/tts', { method: 'POST', body: { text: t } })).arrayBuffer();
        if (seq !== speakSeq) return; // interrompu pendant la synthèse
        await playDeep(ab);
      } catch { if (seq === speakSeq) await browserSpeak(t); }
    } else await browserSpeak(t);
  } finally {
    if (seq === speakSeq) {
      setPhase(S.busy ? 'thinking' : 'idle');
      voice?.setQuick(false);
      setTimeout(() => { if (seq === speakSeq) spokenText = ''; }, 1500); // l'écho de la fin de phrase arrive après
    }
  }
  return seq === speakSeq; // false : on lui a coupé la parole
}
function stopSpeaking() {
  speakSeq++;
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  try { speechSynthesis.cancel(); } catch {}
  voice?.setQuick(false);
  if (S.phase === 'speaking') setPhase(S.busy ? 'thinking' : 'idle');
}
const words = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
/** Le micro a-t-il simplement capté la voix de JARVIS ? (la majorité des mots entendus sont dans la phrase qu'il prononce) */
function isEcho(text) {
  if (!spokenText) return false;
  const heard = words(text); const said = new Set(words(spokenText));
  return heard.length > 0 && heard.filter((w) => said.has(w)).length / heard.length >= 0.6;
}

// ---------------------------------------------------------------- appli de bureau : fenêtre affichée seulement quand on appelle JARVIS
const winEvent = (kind) => { try { desktop?.voiceEvent?.(kind); } catch {} };
/** Fin d'un échange : l'appli peut se remettre en arrière-plan (sauf validation en attente ou écoute en cours). */
function exchangeDone() {
  if (S.approvals.length || S.voiceMode === 'listening' || S.phase !== 'idle') return;
  winEvent('done');
}

// ---------------------------------------------------------------- voix : écoute
let voice = null;
let listenTimer = null;
const sttStamps = [];
let sttBusy = 0;

function enterListening(ms = 8000) {
  if (S.voiceMode === 'off') return;
  clearTimeout(listenTimer);
  setVoice('listening');
  listenTimer = setTimeout(() => { if (S.voiceMode === 'listening') { setVoice('passive'); exchangeDone(); } }, ms);
}

async function onSegment(blob) {
  if (S.voiceMode === 'off') return;
  // Garde-fou de quota (Whisper gratuit : ~20 requêtes/min) : en veille on limite le débit.
  const now = Date.now();
  while (sttStamps.length && now - sttStamps[0] > 60000) sttStamps.shift();
  if (S.voiceMode === 'passive' && sttStamps.length >= (S.phase === 'idle' ? 14 : 24)) return;
  if (sttBusy >= 2) return;
  sttStamps.push(now);
  sttBusy++;
  try {
    const { text } = await json('/api/stt', { method: 'POST', raw: blob });
    handleTranscript((text || '').trim());
  } catch (e) {
    $('#heard').textContent = `Transcription impossible : ${e.message}`;
  } finally {
    sttBusy--;
  }
}

function handleTranscript(text) {
  if (!text || isHallucination(text)) return;
  if (S.prefs.debug) $('#heard').textContent = `« ${text} »`;
  // Pendant qu'il parle ou réfléchit : seul « Jarvis … » compte (n'importe où dans la phrase, pour couvrir le bruit de fond),
  // et jamais l'écho de sa propre voix.
  if (S.phase !== 'idle') {
    const wake = findWake(text, 12);
    if (!wake.found || (isEcho(text) && findWake(spokenText, 999).found)) return;
    beep(990, 0.1);
    winEvent('wake');
    stopSpeaking(); // il se tait dès qu'on l'appelle
    if (wake.command.length >= 2) submitVoice(wake.command, false, true);
    else enterListening(9000);
    return;
  }
  const wake = findWake(text);
  if (S.voiceMode === 'listening') {
    submitVoice(wake.found ? wake.command || '' : text, wake.found && !wake.command);
  } else if (S.voiceMode === 'passive' && wake.found) {
    beep(990, 0.1);
    winEvent('wake');
    if (wake.command.length >= 2) submitVoice(wake.command);
    else enterListening(9000);
  }
}

const YES = /^(oui|ouais|ok|okay|d'accord|vas-y|go|confirme|je confirme|autorise|j'autorise|affirmatif)\b/i;
const NO = /^(non|nan|refuse|annule|stop|surtout pas|n'fais pas|negatif|négatif)\b/i;
// « Jarvis mute », « Jarvis tais-toi », « Jarvis silence »… : il se tait (la tâche en cours continue, sa réponse s'affiche sans être lue).
const MUTE = /^(mute|mutes|muet|silence|chut+|tais[- ]?toi|taisez[- ]?vous|ferme[- ]la|la ferme|arr[eê]te de parler|tu peux te taire|ça suffit|ca suffit)\b/i;
// « Jarvis micro », « Jarvis coupe le micro » : coupe l'écoute.
const MIC_OFF = /^(micro|mic|microphone|coupe (le |ton )?micro|micro off|arr[eê]te d'[ée]couter|n'[ée]coute plus|arr[eê]te l'[ée]coute)\b/i;
const STOP = /^(stop|arrête|arrete|annule|laisse tomber|stoppe)[\s.!]*$/i;

function submitVoice(cmd, onlyWake, interrupting = false) {
  clearTimeout(listenTimer);
  if (onlyWake || !cmd) return enterListening(9000);
  const c = cmd.replace(/[.!?…]+$/, '').trim();
  if (MUTE.test(c)) {
    stopSpeaking();
    if (S.busy || S.phase === 'thinking') S.silent = true; // la réponse en préparation ne sera pas lue
    beep(520, 0.12, 0.04);
    setVoice('passive');
    return exchangeDone();
  }
  if (MIC_OFF.test(c)) {
    stopSpeaking();
    beep(660, 0.1, 0.05); setTimeout(() => beep(440, 0.16, 0.05), 120);
    addMsg('sys', desktop ? 'Micro coupé. Pour le réactiver : bouton micro, icône JARVIS (menu) ou Ctrl+Alt+J.' : 'Micro coupé. Touchez le bouton micro pour le réactiver.');
    if (S.voiceMode !== 'off') toggleMic();
    winEvent('done');
    return;
  }
  if (STOP.test(c)) { cancelAll(); setVoice('passive'); return exchangeDone(); }
  if (interrupting && (S.busy || S.phase === 'thinking')) { wsSend({ type: 'cancel' }); S.skipAbort = true; } // nouvelle demande : l'ancienne est abandonnée
  const ap = S.approvals[0];
  if (ap) {
    if (S.prefs.voiceOk && ap.level === 'risky' && YES.test(cmd)) return answerApproval(true);
    if (NO.test(cmd)) return answerApproval(false);
    if (ap.level === 'danger' && YES.test(cmd)) { addMsg('sys', 'Action dangereuse : validation tactile obligatoire.'); return enterListening(8000); }
  }
  setVoice('passive');
  sendChat(cmd, 'voice');
}

async function toggleMic() {
  if (S.voiceMode !== 'off') {
    voice?.stop();
    voice = null;
    clearTimeout(listenTimer);
    setVoice('off');
    onLevel(0);
    store.set('jv-mic', false);
    winEvent('mic-off');
    return;
  }
  try {
    voice = new VoiceInput({ onSegment, onLevel });
    await voice.start();
    setVoice('passive');
    store.set('jv-mic', true);
    winEvent('mic-on');
    keepAwake();
  } catch (e) {
    voice = null;
    addMsg('error', e.name === 'NotAllowedError'
      ? "Accès au micro refusé. Autorisez-le dans le navigateur (le micro exige une connexion HTTPS)."
      : `Micro indisponible : ${e.message}`);
  }
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.voiceMode !== 'off') keepAwake(); });

// ---------------------------------------------------------------- WebSocket
let wsBackoff = 1000;
function connectWs() {
  if (!S.token) return;
  // Le jeton voyage dans le sous-protocole (pas dans l'URL).
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, ['jarvis.v1', S.token]);
  S.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return remote.onFrame(e.data); // trame d'écran (JPEG)
    if (e.data === 'pong') return;
    try { onWs(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    S.agents = []; render();
    if (ev.code === 4003 || ev.code === 1006 && !S.opened) { /* jeton refusé ou serveur injoignable */ }
    if (S.token) setTimeout(connectWs, wsBackoff = Math.min(wsBackoff * 1.7, 15000));
  };
  ws.onopen = () => { S.opened = true; remote.onReconnect(); };
}
const wsSend = (m) => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(m));
const remote = createRemote({ send: wsSend, getAgent: () => S.agents[S.agents.length - 1] });
window.__remote = remote; // utile pour les tests et le dépannage dans la console
window.__voice = { handleTranscript: (t) => handleTranscript(t), speak: (t) => speak(t), state: S, setPhase: (p) => setPhase(p), setVoice: (m) => setVoice(m) };
setInterval(() => S.ws?.readyState === 1 && S.ws.send('ping'), 25000);

function onWs(m) {
  const mine = m.origin === S.cid;
  switch (m.type) {
    case 'ready': wsBackoff = 1000; break;
    case 'auth_error': logout(); break;
    case 'state':
      S.agents = m.agents; S.busy = m.busy;
      // Un agent qui vient de se reconnecter (ex. après une mise à jour) repart d'un statut vierge.
      for (const a of m.agents) {
        if (S.connAt[a.id] && S.connAt[a.id] !== a.connectedAt) delete S.appStatus[a.id];
        S.connAt[a.id] = a.connectedAt;
      }
      if (!m.busy && S.phase === 'thinking') setPhase('idle');
      render();
      remote.onAgents(m.agents);
      break;
    case 'rc_started': case 'rc_error': remote.onMessage(m); break;
    case 'stats': onStats(m.stats); break;
    case 'app_status': S.appStatus[m.agentId] = m.state; renderPcApp(); break;
    case 'user_message': if (!mine) addMsg('user', m.text + (m.via === 'voice' ? ' 🎙' : '')); break;
    case 'status':
      if (m.state === 'thinking' && S.phase === 'idle' && mine) setPhase('thinking');
      if (m.state === 'idle' && S.phase === 'thinking') setPhase('idle');
      break;
    case 'tool_start': {
      const el = document.createElement('div');
      el.className = 'tool run';
      el.textContent = `${m.name} ${brief(m.args)}`;
      $('#log').append(el); toolEls.set(m.id, el); scroll();
      activity(m.id, m.name, brief(m.args), 'run');
      break;
    }
    case 'tool_result': {
      const el = toolEls.get(m.id);
      if (el) { el.className = `tool ${m.ok ? 'ok' : 'fail'}`; el.title = m.preview; }
      activity(m.id, m.name, '', m.ok ? 'ok' : 'fail');
      break;
    }
    case 'assistant_message': {
      addMsg('assistant', m.text);
      if (!mine) break;
      // Réponse d'une demande annulée (« Très bien, j'arrête. ») : affichée, jamais lue.
      if (S.skipAbort && /^Très bien, j.arrête\.?$/.test(m.text)) { S.skipAbort = false; break; }
      const silent = S.silent; S.silent = false;
      if (!silent && S.prefs.speak && (m.via === 'voice' || S.prefs.speakAll)) {
        // Après sa réponse il repasse en veille : il faut redire « Jarvis » (sauf si le mode conversation est activé).
        speak(m.text).then((finished) => {
          if (!finished) return; // interrompu : la suite est gérée par l'interruption
          if (S.prefs.follow && S.voiceMode !== 'off' && S.approvals.length === 0) enterListening(7000);
          else exchangeDone();
        });
      } else setTimeout(exchangeDone, 1500);
      break;
    }
    case 'error':
      addMsg('error', m.message);
      if (mine) { setPhase('idle'); setTimeout(exchangeDone, 4000); }
      break;
    case 'approval_request': showApproval(m); break;
    case 'approval_resolved': closeApproval(m.id, m); break;
  }
}
const brief = (a) => { const s = a ? Object.values(a).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ') : ''; return s.length > 90 ? `${s.slice(0, 90)}…` : s; };

function sendChat(text, via = 'text') {
  if (!text.trim()) return;
  addMsg('user', text + (via === 'voice' ? ' 🎙' : ''));
  S.silent = false;
  setPhase('thinking');
  wsSend({ type: 'chat', text, via, cid: S.cid, agentId: S.agents[S.agents.length - 1]?.id });
}
function cancelAll() {
  if (S.busy || S.phase === 'thinking') S.skipAbort = true;
  wsSend({ type: 'cancel' });
  stopSpeaking();
  setPhase('idle');
}

// ---------------------------------------------------------------- validations
function showApproval(req) {
  if (!S.approvals.find((a) => a.id === req.id)) S.approvals.push(req);
  navigator.vibrate?.([200, 100, 200]);
  beep(440, 0.25, 0.08);
  winEvent('wake'); // la validation doit être visible
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('JARVIS — validation requise', { body: req.summary.slice(0, 120) });
  if (!$('#approval').open) renderApproval();
  if (S.prefs.speak && S.voiceMode !== 'off') {
    const short = req.level === 'danger' ? "Action dangereuse. Validation sur l'écran requise." : (S.prefs.voiceOk ? 'Cette action est risquée. Confirmez-vous ?' : "Validation requise sur l'écran.");
    speak(short).then(() => { if (S.prefs.voiceOk && req.level === 'risky') enterListening(15000); });
  }
}
function renderApproval() {
  const req = S.approvals[0];
  const dlg = $('#approval');
  if (!req) { if (dlg.open) dlg.close(); return; }
  dlg.classList.toggle('danger-level', req.level === 'danger');
  $('#ap-badge').textContent = req.level === 'danger' ? '⚠ Action dangereuse' : 'Action risquée';
  $('#ap-title').textContent = `JARVIS demande l'autorisation${req.agentName ? ` sur ${req.agentName}` : ''}`;
  $('#ap-summary').textContent = req.summary;
  $('#ap-reason').textContent = req.reason ? `Pourquoi : ${req.reason}` : '';
  const total = Math.max(1000, req.expiresAt - Date.now());
  const bar = $('#ap-bar');
  bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => { bar.style.transition = `transform ${total}ms linear`; bar.style.transform = 'scaleX(0)'; });
  if (!dlg.open) dlg.showModal();
}
function answerApproval(approved) {
  const req = S.approvals[0];
  if (!req) return;
  wsSend({ type: 'approval', id: req.id, approved });
  closeApproval(req.id, { approved });
}
function closeApproval(id, info) {
  const i = S.approvals.findIndex((a) => a.id === id);
  if (i < 0) return;
  S.approvals.splice(i, 1);
  addMsg('sys', info.approved ? 'Action autorisée.' : `Action refusée${info.reason ? ` (${info.reason})` : ''}.`);
  renderApproval();
  setTimeout(exchangeDone, 1500);
}
$('#ap-allow').onclick = () => answerApproval(true);
$('#ap-deny').onclick = () => answerApproval(false);
$('#approval').addEventListener('cancel', (e) => { e.preventDefault(); answerApproval(false); });

// ---------------------------------------------------------------- session
function logout() {
  S.token = null; store.del('jv-token');
  try { S.ws?.close(); } catch {}
  S.ws = null;
  voice?.stop(); voice = null;
  location.replace('/');
}

async function enterApp() {
  const [{ user }, cfg] = await Promise.all([json('/api/me'), json('/api/config')]);
  S.user = user;
  $('#who').textContent = user.username;
  $('#app').hidden = false;
  $('#log').innerHTML = '';
  try {
    const { messages } = await json('/api/history');
    messages.forEach((m) => addMsg(m.role === 'user' ? 'user' : 'assistant', m.content));
  } catch {}
  if (!cfg.hasKey) addMsg('error', "Aucune clé API configurée côté serveur.");
  render();
  connectWs();
  if (desktop) {
    // Appli de bureau : le micro est autorisé d'office et le PC s'associe automatiquement au compte.
    toggleMic();
    await pairPc();
    // PC retiré du compte pendant que l'appli tourne : on ne le ré-associe PAS en silence (sinon « Révoquer » ne servirait à rien
    // sur un PC perdu) ; la session se ferme, et il se ré-associe à la prochaine connexion volontaire (pairPc ci-dessous).
    if (!pairHooked) {
      pairHooked = true;
      desktop.onRevoked?.(() => { if (S.token) logout(); });
      desktop.onToggleMic?.(() => toggleMic()); // menu de l'icône ou raccourci Ctrl+Alt+J
    }
  }
}

/** Associe ce PC au compte connecté. Refait l'association si le PC a été retiré du compte (jeton mort) ou appartient à un autre compte. */
let pairHooked = false;
let pairing = false;
async function pairPc() {
  if (pairing) return;
  pairing = true;
  try {
    if (await desktop.agentConfigured?.()) {
      const { deviceId } = (await desktop.agentInfo?.()) || {};
      if (!deviceId) return; // ancienne configuration sans identifiant : le jeton mort sera signalé par l'agent
      const { devices } = await json('/api/devices');
      if (devices.some((d) => d.id === deviceId)) return; // déjà associé à ce compte
    }
    const name = (await desktop.hostname?.()) || 'Mon PC';
    const dev = await json('/api/devices', { method: 'POST', body: { name } });
    await desktop.connectAgent({ server: location.origin, token: dev.token, deviceId: dev.id, name });
    addMsg('sys', `PC « ${name} » associé à votre compte.`);
    setTimeout(loadDevices, 3000);
  } catch (e) { addMsg('error', `Association du PC impossible : ${e.message}`); }
  finally { pairing = false; }
}


// ---------------------------------------------------------------- mises à jour de l'appli de bureau
const vgt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
let latestApp = null; // manifeste public /update.json (version la plus récente publiée)
fetch('/update.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((m) => { latestApp = m; renderPcApp(); }).catch(() => {});

const UPD_TEXT = {
  checking: 'Recherche de mises à jour…', downloading: (s) => `Téléchargement de la v${s.latest}… ${s.percent} %`, ready: (s) => `v${s.latest} prête : redémarrage pour l'installer…`,
  restarting: 'Redémarrage en cours…', uptodate: 'Appli à jour.', unsupported: 'Cet agent ne gère pas les mises à jour.', error: (s) => `Erreur de mise à jour : ${s.error || 'inconnue'}`,
  major: (s) => `La v${s.latest} demande une réinstallation de l'appli.`,
};
const updText = (s) => { const t = UPD_TEXT[s.phase]; return typeof t === 'function' ? t(s) : t || ''; };

/** Ligne « Appli » du panneau PC : version installée, mise à jour disponible, bouton pour la lancer depuis le site/téléphone. */
function renderPcApp() {
  const agent = S.agents[S.agents.length - 1];
  const box = $('#pc-upd');
  if (!agent) { $('#pc-app').textContent = '—'; box.hidden = true; return; }
  $('#pc-app').textContent = agent.appVersion ? `v${agent.appVersion}` : 'ancienne version';
  const st = S.appStatus[agent.id];
  const busy = st && ['checking', 'downloading', 'ready', 'restarting'].includes(st.phase);
  const newer = latestApp && (!agent.appVersion || vgt(latestApp.version, agent.appVersion));
  const btn = $('#btn-pc-update');
  if (busy) { box.hidden = false; $('#pc-upd-text').textContent = updText(st); btn.hidden = true; return; }
  btn.hidden = false;
  if (st && ['error', 'unsupported', 'major'].includes(st.phase)) { box.hidden = false; $('#pc-upd-text').textContent = updText(st); btn.hidden = st.phase !== 'error' || !newer; return; }
  if (newer) {
    box.hidden = false;
    if (agent.canUpdate) { $('#pc-upd-text').textContent = `v${latestApp.version} disponible`; btn.textContent = 'Mettre à jour le PC'; }
    else { $('#pc-upd-text').textContent = `v${latestApp.version} disponible : cette appli est trop ancienne, réinstallez-la (/download).`; btn.hidden = true; }
  } else box.hidden = true;
}
$('#btn-pc-update').onclick = () => {
  const agent = S.agents[S.agents.length - 1];
  if (!agent) return;
  S.appStatus[agent.id] = { phase: 'checking', current: agent.appVersion };
  renderPcApp();
  wsSend({ type: 'app_cmd', agentId: agent.id, cmd: 'update' });
};

/** Appli de bureau (Electron) : bannière « mise à jour prête » + réglages. */
function renderDesktopUpdate(s) {
  const bar = $('#upd-bar'), text = $('#upd-text'), btn = $('#upd-btn');
  if (!s || ['unsupported', 'idle', 'uptodate', 'checking', 'error'].includes(s.phase)) { bar.hidden = true; } else {
    bar.hidden = false; bar.classList.toggle('busy', s.phase === 'downloading' || s.phase === 'restarting');
    text.textContent = s.phase === 'available' ? `Mise à jour v${s.latest} disponible` : updText(s);
    btn.hidden = !['available', 'ready', 'major'].includes(s.phase);
    btn.textContent = s.phase === 'ready' ? 'Redémarrer maintenant' : s.phase === 'major' ? 'Télécharger' : 'Installer et redémarrer';
    btn.onclick = () => (s.phase === 'major' ? window.open('/download', '_blank') : desktop.update.install());
  }
  const info = $('#set-app-ver');
  if (info && s) info.textContent = `Version installée : v${s.current}${s.phase === 'uptodate' ? ' — à jour' : s.latest ? ` — v${s.latest} : ${s.phase}` : ''}`;
  const inst = $('#btn-app-install');
  if (inst) inst.hidden = !(s && ['available', 'ready'].includes(s.phase));
}
if (desktop?.update) {
  desktop.update.state().then(renderDesktopUpdate).catch(() => {});
  desktop.update.onState(renderDesktopUpdate);
}
// ---------------------------------------------------------------- réglages
function savePrefs() { store.set('jv-prefs', S.prefs); }
async function openSettings() {
  const d = $('#settings');
  for (const [id, key] of [['set-speak', 'speak'], ['set-speak-all', 'speakAll'], ['set-follow', 'follow'], ['set-voiceok', 'voiceOk'], ['set-debug', 'debug']]) {
    const el = $(`#${id}`); el.checked = !!S.prefs[key];
    el.onchange = () => { S.prefs[key] = el.checked; savePrefs(); if (key === 'debug' && !el.checked) $('#heard').textContent = ''; };
  }
  const depth = $('#set-depth');
  depth.value = S.prefs.depth;
  depth.oninput = () => { S.prefs.depth = Number(depth.value); savePrefs(); };
  $('#set-user').textContent = `Connecté : ${S.user.username}${S.user.isAdmin ? ' (admin)' : ''}`;
  $('#set-desktop').hidden = !desktop;
  $('#set-app').hidden = !desktop?.update;
  if (desktop?.update) {
    const p = await desktop.update.prefs();
    $('#set-autoupd').checked = !!p.autoUpdate; $('#set-autorestart').checked = !!p.autoRestart;
    renderDesktopUpdate(await desktop.update.state());
  }
  if (desktop) $('#set-autonomy').value = (await desktop.getAutonomy?.()) || 'balanced';
  try {
    const s = await json('/api/settings');
    $('#set-admin').hidden = !s.isAdmin;
    $('#set-key').hidden = !!s.cloud;
    $('#set-provider').textContent = `— ${s.provider} / ${s.chatModel}`;
    $('#set-keyhint').textContent = s.cloud ? `Clé enregistrée côté Cloudflare (${s.keyHint}).` : s.hasKey ? `Clé enregistrée (${s.keyHint}).` : 'Aucune clé enregistrée.';
    if (s.isAdmin) { loadInvites(); if (s.cloud) { loadProviders(); loadInfoSettings(); } }
  } catch {}
  await loadDevices();
  loadVoices(); loadAccounts(); loadGoogle();
  if (!d.open) d.showModal();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
// Boîte mail et messageries : réglées uniquement depuis l'appli de bureau (les identifiants restent chiffrés sur le PC).
async function loadAccounts() {
  const sec = $('#set-accounts');
  if (!desktop?.accounts) { sec.hidden = true; return; }
  sec.hidden = false;
  try {
    const st = await desktop.accounts('status');
    $('#acc-mail-state').textContent = st.mail.configured ? `— ${st.mail.address}` : '— non configurée';
    $('#btn-mail-remove').hidden = !st.mail.configured;
    $('#acc-msg-state').textContent = `— ${[st.messaging.telegram && 'Telegram', st.messaging.discord && 'Discord'].filter(Boolean).join(', ') || 'aucun canal'}`;
  } catch (e) { $('#acc-mail-state').textContent = `— ${e.message}`; }
}
$('#acc-preset').onchange = (e) => { $('#acc-custom').hidden = e.target.value !== 'custom'; };
const hostPort = (s, def) => { const m = /^([^:\s]+)(?::(\d+))?$/.exec(String(s).trim()); return m ? { host: m[1], port: Number(m[2]) || def, secure: (Number(m[2]) || def) !== 587 } : null; };
$('#btn-mail-save').onclick = async (ev) => {
  const btn = ev.currentTarget; const preset = $('#acc-preset').value;
  const args = { preset, address: $('#acc-addr').value.trim(), password: $('#acc-pass').value };
  if (preset === 'custom') { args.imap = hostPort($('#acc-imap').value, 993); args.smtp = hostPort($('#acc-smtp').value, 465); if (!args.imap || !args.smtp) { addMsg('error', 'Serveurs IMAP / SMTP invalides.'); return; } }
  btn.disabled = true; btn.textContent = 'Test de connexion…';
  try { await desktop.accounts('mail-setup', args); $('#acc-pass').value = ''; addMsg('sys', 'Boîte mail connectée. Essaie : « Jarvis, ai-je de nouveaux mails ? »'); }
  catch (e) { addMsg('error', String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  btn.disabled = false; btn.textContent = 'Tester et enregistrer'; loadAccounts();
};
$('#btn-mail-remove').onclick = async () => { await desktop.accounts('mail-remove'); addMsg('sys', 'Boîte mail retirée de ce PC.'); loadAccounts(); };
$('#btn-msg-save').onclick = async (ev) => {
  const btn = ev.currentTarget;
  const args = { telegramToken: $('#acc-tg-token').value.trim(), telegramChatId: $('#acc-tg-chat').value.trim(), discordUrl: $('#acc-dc').value.trim() };
  if (!args.telegramToken) { delete args.telegramToken; delete args.telegramChatId; }
  if (!args.discordUrl) delete args.discordUrl;
  if (!args.telegramToken && !args.discordUrl) { addMsg('error', 'Renseigne Telegram ou Discord.'); return; }
  btn.disabled = true;
  try { await desktop.accounts('msg-setup', args); for (const i of ['#acc-tg-token', '#acc-tg-chat', '#acc-dc']) $(i).value = ''; addMsg('sys', 'Messagerie enregistrée. « Jarvis, envoie un message Telegram… » demandera ta validation.'); }
  catch (e) { addMsg('error', String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  btn.disabled = false; loadAccounts();
};
async function loadVoices() {
  const box = $('#voice-list');
  try {
    const v = await json('/api/voices');
    if (!v.piper) { $('#set-voices').hidden = true; return; }
    $('#set-voices').hidden = false;
    $('#voice-cur').textContent = `— ${v.voices.find((x) => x.current)?.label || ''}`;
    box.replaceChildren();
    for (const x of v.voices) {
      const row = document.createElement('div'); row.className = 'prov';
      const head = document.createElement('div'); head.className = 'prov-head';
      const name = document.createElement('strong'); name.textContent = `${x.current ? '🟢' : x.installed ? '⚪' : '⬇'} ${x.label}`;
      const desc = document.createElement('span'); desc.className = 'muted'; desc.textContent = x.desc;
      head.append(name, desc); row.append(head);
      const btns = document.createElement('div'); btns.className = 'row'; btns.style.marginTop = '4px';
      const act = (label, action) => {
        const b = document.createElement('button'); b.className = 'btn small'; b.type = 'button'; b.textContent = label;
        b.onclick = async () => {
          b.disabled = true; b.textContent = action === 'install' ? 'Téléchargement…' : '…';
          try { const r = await json('/api/voices', { method: 'POST', body: { action, id: x.id } }); addMsg('sys', r.message); speak('Bonsoir. Je suis JARVIS, à votre service.'); }
          catch (e) { addMsg('error', e.message); }
          loadVoices();
        };
        return b;
      };
      if (x.current) { const p = document.createElement('span'); p.className = 'muted'; p.textContent = 'Voix active'; btns.append(p); }
      else if (x.installed) btns.append(act('Utiliser', 'select'));
      else btns.append(act(`Télécharger (${x.mb} Mo) et utiliser`, 'install'));
      row.append(btns); box.append(row);
    }
  } catch { $('#set-voices').hidden = true; }
}
const DAY_NAMES =['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
const DAY_FULL = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
function ttToText(list) {
  return (list || []).map((t) => `${DAY_FULL[t.day - 1]} ${t.start}${t.end ? `-${t.end}` : ''} ${t.title}${t.place ? ` @ ${t.place}` : ''}`).join('\n');
}
function ttFromText(text) {
  const out = []; const bad = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = /^([a-zéû]+)\.?\s+(\d{1,2}[:h]\d{2})(?:\s*[-–àa]\s*(\d{1,2}[:h]\d{2}))?\s+(.+?)(?:\s*@\s*(.+))?$/i.exec(line);
    const day = m ? DAY_NAMES.indexOf(m[1].toLowerCase().slice(0, 3)) : -1;
    if (!m || day < 0) { bad.push(line); continue; }
    out.push({ day: day + 1, start: m[2].replace('h', ':'), end: (m[3] || '').replace('h', ':'), title: m[4].trim(), place: (m[5] || '').trim() });
  }
  return { out, bad };
}
async function loadInfoSettings() {
  try {
    const i = await json('/api/info');
    $('#set-info').hidden = false;
    $('#info-city').value = i.city; $('#info-ics').value = '';
    $('#info-ics-hint').textContent = i.hasIcs ? `Calendrier enregistré (${i.icsHint}).` : 'Aucun calendrier enregistré.';
    $('#info-tt').value = ttToText(i.timetable);
  } catch { $('#set-info').hidden = true; }
}
$('#btn-info-save').onclick = async (ev) => {
  const btn = ev.currentTarget; const { out, bad } = ttFromText($('#info-tt').value);
  if (bad.length) { addMsg('error', `Créneau illisible : « ${bad[0]} » (format : lundi 08:00-09:30 Maths @ salle 12).`); return; }
  const body = { city: $('#info-city').value.trim(), timetable: out };
  const ics = $('#info-ics').value.trim(); if (ics) body.icsUrl = ics;
  btn.disabled = true;
  try { const r = await json('/api/info', { method: 'PUT', body }); addMsg('sys', r.notes.length ? r.notes.join(' · ') : 'Enregistré.'); loadInfoSettings(); }
  catch (e) { addMsg('error', e.message); }
  btn.disabled = false;
};
const PROV_LABEL ={ principal: 'Groq', cloudflare: 'Cloudflare', mistral: 'Mistral', gemini: 'Gemini', openrouter: 'OpenRouter', cerebras: 'Cerebras' };
async function loadProviders() {
  try {
    const st = await json('/api/providers');
    $('#set-providers').hidden = false;
    $('#set-prov-order').textContent = `— ordre : ${st.order.map((id) => PROV_LABEL[id] || id).join(' → ')}`;
    const box = $('#prov-list'); box.innerHTML = '';
    for (const p of st.fallbacks) {
      const row = document.createElement('div'); row.className = 'prov';
      const head = document.createElement('div'); head.className = 'prov-head';
      const name = document.createElement('strong'); name.textContent = `${p.configured ? '🟢' : '⚪'} ${p.name}`;
      const link = document.createElement('a'); link.href = p.signup; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'obtenir une clé';
      head.append(name, link);
      const note = document.createElement('div'); note.className = 'muted'; note.textContent = p.note;
      row.append(head, note);
      if (p.configured) {
        const info = document.createElement('div'); info.className = 'muted';
        info.textContent = p.source === 'secret' ? `Clé Cloudflare (${p.hint}).` : `Clé enregistrée (${p.hint}).`;
        row.append(info);
        if (p.source === 'app') {
          const del = document.createElement('button'); del.className = 'btn small danger'; del.type = 'button'; del.textContent = 'Retirer';
          del.onclick = async () => { await api(`/api/providers/${p.id}`, { method: 'DELETE' }); loadProviders(); };
          row.append(del);
        }
      } else {
        const wrap = document.createElement('div'); wrap.className = 'row'; wrap.style.marginTop = '4px';
        const inp = document.createElement('input'); inp.type = 'password'; inp.placeholder = 'Clé API'; inp.autocomplete = 'off';
        const ok = document.createElement('button'); ok.className = 'btn small'; ok.type = 'button'; ok.textContent = 'Tester et enregistrer';
        ok.onclick = async () => {
          const key = inp.value.trim(); if (!key) return;
          ok.disabled = true; ok.textContent = 'Test…';
          try { const r = await json(`/api/providers/${p.id}`, { method: 'PUT', body: { key } }); addMsg('sys', `${p.name} : clé valide (${r.models} modèles). Secours activé.`); loadProviders(); }
          catch (e) { addMsg('error', e.message); ok.disabled = false; ok.textContent = 'Tester et enregistrer'; }
        };
        wrap.append(inp, ok); row.append(wrap);
      }
      box.append(row);
    }
  } catch { $('#set-providers').hidden = true; }
}
// Compte Google (Gmail + Agenda) : la connexion passe par Google puis revient sur /chat/?google=…
async function loadGoogle() {
  const sec = $('#set-google');
  try {
    const g = await json('/api/google');
    sec.hidden = !g.available;
    $('#google-state').textContent = g.connected ? `— ${g.email}` : '';
    $('#btn-google').textContent = g.connected ? 'Reconnecter' : 'Connecter Google';
    $('#btn-google-off').hidden = !g.connected;
  } catch { sec.hidden = true; }
}
$('#btn-google').onclick = async () => {
  try {
    const { url } = await json('/api/google/connect', { method: 'POST' });
    location.href = url;
  } catch (e) { addMsg('error', e.message); }
};
$('#btn-google-off').onclick = async () => {
  if (!confirm('Déconnecter Google ? JARVIS ne pourra plus lire ton Gmail ni ton agenda.')) return;
  try { await api('/api/google', { method: 'DELETE' }); addMsg('sys', 'Google déconnecté.'); loadGoogle(); } catch (e) { addMsg('error', e.message); }
};
{
  const r = new URLSearchParams(location.search).get('google');
  if (r) {
    history.replaceState(null, '', location.pathname);
    const msg = { ok: 'Google est connecté.', denied: 'Connexion Google annulée.', scopes: 'Il manque des autorisations : coche toutes les cases demandées par Google.', error: 'La connexion Google a échoué, réessaie.' }[r];
    if (msg) setTimeout(() => addMsg(r === 'ok' ? 'sys' : 'error', msg), 800);
  }
}
async function loadInvites() {
  try {
    const { invites } = await json('/api/invites');
    $('#invite-list').innerHTML = '';
    for (const i of invites) {
      const row = document.createElement('div');
      row.textContent = `${i.code} — ${i.used_by ? `utilisé par ${i.used_by}` : 'disponible'}`;
      $('#invite-list').append(row);
    }
  } catch { $('#btn-invite').hidden = true; }
}
$('#btn-invite').onclick = async () => {
  try {
    const { code } = await json('/api/invites', { method: 'POST' });
    addMsg('sys', `Code d'invitation créé : ${code}`);
    loadInvites();
  } catch (e) { addMsg('error', e.message); }
};
async function loadDevices() {
  try {
    const { devices } = await json('/api/devices');
    const ul = $('#set-devices'); ul.innerHTML = '';
    if (!devices.length) ul.innerHTML = '<li class="muted">Aucun PC associé. Installez l\'appli de bureau JARVIS sur le PC à piloter.</li>';
    for (const dv of devices) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><button class="btn small danger">Révoquer</button>';
      li.firstChild.textContent = `${dv.online ? '🟢' : '⚪'} ${dv.name}`;
      li.querySelector('button').onclick = async () => { await api(`/api/devices/${dv.id}`, { method: 'DELETE' }); loadDevices(); };
      ul.append(li);
    }
  } catch {}
}
$('#btn-settings').onclick = openSettings;
$('#btn-close-settings').onclick = async () => {
  const key = $('#set-key').value.trim();
  if (key && !$('#set-key').hidden) { try { await api('/api/settings', { method: 'PUT', body: { apiKey: key } }); $('#set-key').value = ''; addMsg('sys', 'Clé API enregistrée.'); } catch (e) { addMsg('error', e.message); } }
  $('#settings').close();
};
$('#btn-logout').onclick = () => { $('#settings').close(); logout(); };
$('#btn-clear').onclick = async () => { await api('/api/history', { method: 'DELETE' }); $('#log').innerHTML = ''; addMsg('sys', 'Historique effacé.'); };
$('#set-autoupd').onchange = (e) => desktop?.update?.setPrefs({ autoUpdate: e.target.checked });
$('#set-autorestart').onchange = (e) => desktop?.update?.setPrefs({ autoRestart: e.target.checked });
$('#btn-app-check').onclick = async () => { $('#set-app-ver').textContent = 'Recherche…'; renderDesktopUpdate(await desktop.update.check()); };
$('#btn-app-install').onclick = () => desktop.update.install();
$('#set-autonomy').onchange = (e) => desktop?.setAutonomy?.(e.target.value);

// ---------------------------------------------------------------- événements UI
$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#chat-input').value.trim();
  if (!v) return;
  $('#chat-input').value = '';
  sendChat(v, 'text');
};
$('#btn-mic').onclick = toggleMic;
// Ouvrir l'écran à distance DANS le clic : c'est ce geste qui autorise l'ouverture du clavier sur téléphone.
$('#btn-remote').onclick = () => { if (!remote.open()) addMsg('error', "Aucun PC connecté : impossible d'afficher l'écran."); };
$('#btn-stop').onclick = cancelAll;
$('#btn-panels').onclick = () => { $('#app').classList.toggle('panels-open'); setTimeout(() => { drawGraph($('#g-cpu'), S.stats.cpu); drawGraph($('#g-ram'), S.stats.ram); }, 50); };
window.addEventListener('resize', () => { drawGraph($('#g-cpu'), S.stats.cpu); drawGraph($('#g-ram'), S.stats.ram); });

// ---------------------------------------------------------------- démarrage
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (S.token) enterApp().catch(() => { /* 401 géré par api() */ });
