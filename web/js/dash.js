// 2e écran JARVIS : horloge, météo, emploi du temps, état du PC, fil de conversation.
const $ = (s) => document.querySelector(s);
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } } };
const token = store.get('jv-token');
if (!token) location.replace(`/auth/?next=${encodeURIComponent(location.pathname)}`);

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const authFetch = async (path) => {
  const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401) { localStorage.removeItem('jv-token'); location.replace('/auth/?next=/dash'); throw new Error('401'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

let D = null; // dernières données /api/dash
const TZ = () => D?.tz || 'Europe/Paris';

// ---------------------------------------------------------------- horloge
function parts(epoch, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('fr-FR', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(epoch))) o[p.type] = p.value;
  return o;
}
function tick() {
  const now = Date.now();
  const p = parts(now, TZ());
  $('#d-time').textContent = `${p.hour}:${p.minute}`;
  $('#d-sec').textContent = p.second;
  $('#d-date').textContent = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ(), dateStyle: 'full' }).format(now);
  if (D?.schedule) renderAgenda(now); // met à jour « en cours / terminé » et le compte à rebours
}
setInterval(tick, 1000);

// ---------------------------------------------------------------- météo
const ICON = (code, day = true) => (code <= 1 ? (day ? '☀️' : '🌙') : code === 2 ? (day ? '⛅' : '☁️') : code === 3 ? '☁️' : code <= 48 ? '🌫️' : code <= 57 ? '🌦️' : code <= 67 ? '🌧️' : code <= 77 ? '❄️' : code <= 82 ? '🌦️' : code <= 86 ? '🌨️' : '⛈️');
function renderWeather() {
  const box = $('#w-body'); box.className = ''; box.replaceChildren();
  $('#w-city').textContent = D.city ? `— ${D.city}` : '';
  if (!D.configured.city) { box.className = 'muted'; box.textContent = 'Aucune ville : Réglages → Infos du quotidien (sur /chat).'; return; }
  if (!D.weather) { box.className = 'muted'; box.textContent = D.weatherError ? `Météo indisponible (${D.weatherError}).` : 'Chargement…'; return; }
  const n = D.weather.now;
  const now = el('div', 'w-now');
  const info = el('div');
  info.append(el('div', 'w-temp mono', `${n.temp}°`), el('div', 'w-text', n.text), el('div', 'w-meta', `Ressenti ${n.feels}° · vent ${n.wind} km/h · humidité ${n.humidity} %`));
  now.append(el('div', 'w-icon', ICON(n.code, n.isDay)), info);
  const today = D.weather.days[0];
  const sun = today?.sunrise ? el('div', 'w-meta', `Lever ${today.sunrise} · coucher ${today.sunset}`) : null;
  const days = el('div', 'w-days');
  for (const d of D.weather.days) {
    const c = el('div', 'w-day');
    const name = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d.date}T12:00:00Z`));
    c.append(el('b', '', name), el('span', 'ic', ICON(d.code)), el('span', 'hi mono', `${d.max}°`), el('span', 'lo mono', `${d.min}°`), el('span', 'rain', d.rain != null ? `💧 ${d.rain} %` : ''));
    days.append(c);
  }
  box.append(now, ...(sun ? [sun] : []), days);
}

// ---------------------------------------------------------------- agenda
const pad = (n) => String(n).padStart(2, '0');
function renderAgenda(nowMs = Date.now()) {
  const box = $('#a-body'); const next = $('#a-next');
  if (!D.configured.schedule) { box.className = 'muted'; box.textContent = 'Aucun emploi du temps : Réglages → Infos du quotidien (lien de calendrier ou planning).'; next.hidden = true; return; }
  if (!D.schedule) { box.className = 'muted'; box.textContent = D.scheduleError ? `Agenda indisponible (${D.scheduleError}).` : 'Chargement…'; next.hidden = true; return; }
  const p = parts(nowMs, TZ()); const hm = `${p.hour}:${p.minute}`;
  const todayKey = `${p.year}-${p.month}-${p.day}`;
  const rows = [];
  for (const day of [D.schedule.today, D.schedule.tomorrow]) {
    const list = D.schedule.items.filter((i) => i.key === day);
    rows.push(el('div', 'a-day', day === D.schedule.today ? "Aujourd'hui" : 'Demain'));
    if (!list.length) rows.push(el('div', 'muted', 'Rien de prévu.'));
    for (const it of list) {
      const isToday = it.key === todayKey;
      const past = isToday && it.start && (it.end || it.start) <= hm;
      const cur = isToday && it.start && it.end && it.start <= hm && hm < it.end;
      const r = el('div', `a-item${past ? ' past' : ''}${cur ? ' now' : ''}`);
      r.append(el('span', 'h', it.allDay ? 'Journée' : it.end ? `${it.start}–${it.end}` : it.start || ''));
      const t = el('span', '', it.title);
      if (it.place) t.append(el('span', 'p', it.place));
      r.append(t); rows.push(r);
    }
  }
  box.className = ''; box.replaceChildren(...rows);
  // prochain événement + compte à rebours
  const nx = D.schedule.next;
  if (nx) {
    const [h, m] = nx.start.split(':').map(Number);
    const [y, mo, d] = nx.key.split('-').map(Number);
    const target = Date.UTC(y, mo - 1, d, h, m); // minutes « murales » : comparées à l'heure murale actuelle
    const cur = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const mins = Math.round((target - cur) / 60000);
    next.hidden = false; next.replaceChildren(
      el('div', 'w', mins <= 0 ? 'En cours' : mins < 60 ? `Prochain dans ${mins} min` : mins < 1440 ? `Prochain dans ${Math.floor(mins / 60)} h ${pad(mins % 60)}` : `Prochain le ${nx.key}`),
      el('div', 't', `${nx.start} · ${nx.title}${nx.place ? ` (${nx.place})` : ''}`),
    );
  } else next.hidden = true;
}

async function refresh() {
  try { D = await authFetch('/api/dash'); renderWeather(); renderAgenda(); tick(); } catch (e) { console.error('dash', e); if (!D) $('#w-body').textContent = `Erreur : ${e.message}`; }
}
// ---------------------------------------------------------------- boîte mail (lue sur le PC, rien n'est stocké sur le site)
async function refreshMail() {
  const box = $('#mail-body');
  try {
    const m = await authFetch('/api/mail');
    $('#mail-count').textContent = '';
    box.className = 'muted';
    if (m.offline) return box.replaceChildren('PC hors ligne : la boîte mail se lit depuis ton PC.');
    if (m.error) return box.replaceChildren(`Boîte mail indisponible (${m.error}).`);
    if (!m.configured) return box.replaceChildren("Non configurée : appli de bureau → Réglages → Boîte mail.");
    $('#mail-count').textContent = m.unread ? `— ${m.unread}${m.unread >= 6 ? '+' : ''} non lu${m.unread > 1 ? 's' : ''}` : '';
    if (!m.items.length) return box.replaceChildren('Aucun mail non lu.');
    box.className = '';
    box.replaceChildren(...m.items.map((i) => { const d = el('div', 'mail-item'); d.append(el('span', 'f', i.from.replace(/<.*>/, '').trim() || i.from), el('span', 's', i.subject)); return d; }));
  } catch (e) { if (e.message !== '401') box.textContent = `Boîte mail indisponible (${e.message}).`; }
}
refreshMail(); setInterval(refreshMail, 2 * 60 * 1000);
refresh(); setInterval(refresh, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---------------------------------------------------------------- temps réel (PC + conversation)
const fmtB = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} Go` : `${Math.round(b / 2 ** 20)} Mo`);
function onStats(st) {
  const ram = Math.round((st.ramUsed / st.ramTotal) * 100);
  $('#m-cpu').textContent = `${st.cpu} %`; $('#b-cpu').style.width = `${st.cpu}%`;
  $('#m-ram').textContent = `${ram} %`; $('#b-ram').style.width = `${ram}%`;
  $('#m-disks').replaceChildren(...(st.disks || []).map((d) => {
    const used = Math.round(((d.total - d.free) / d.total) * 100);
    const r = el('div', 'd-meter'); const bar = el('div', 'bar'); const i = el('i'); i.style.width = `${used}%`; bar.append(i);
    r.append(el('span', '', `Disque ${d.name}`), el('b', 'mono', `${used} %`), bar); r.querySelector('b').style.fontSize = '1rem';
    return r;
  }));
  if (st.uptime) { const h = Math.floor(st.uptime / 3600); $('#m-up').textContent = `Allumé depuis ${h >= 24 ? `${Math.floor(h / 24)} j ` : ''}${h % 24} h`; }
}
function addFeed(kind, text) {
  const f = $('#feed'); if (f.querySelector('.muted')) f.replaceChildren();
  f.append(el('div', `m ${kind}`, text));
  while (f.children.length > 40) f.firstChild.remove();
  f.scrollTop = f.scrollHeight;
}
let ws; let backoff = 1000; const cid = Math.random().toString(36).slice(2, 10); let agents = [];
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, ['jarvis.v1', token]);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string' || e.data === 'pong') return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'ready') backoff = 1000;
    else if (m.type === 'auth_error') { localStorage.removeItem('jv-token'); location.replace('/auth/?next=/dash'); }
    else if (m.type === 'state') { agents = m.agents; $('#d-pc-name').textContent = agents.length ? agents[agents.length - 1].name : 'Aucun PC'; $('#d-pc').classList.toggle('online', agents.length > 0); }
    else if (m.type === 'stats') onStats(m.stats);
    else if (m.type === 'user_message') addFeed('user', m.text);
    else if (m.type === 'assistant_message') addFeed('assistant', m.text);
    else if (m.type === 'error') addFeed('error', m.message);
  };
  ws.onclose = () => setTimeout(connect, (backoff = Math.min(backoff * 1.7, 15000)));
}
connect();
setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25000);

$('#d-form').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#d-input').value.trim(); if (!text || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'chat', text, via: 'text', cid, agentId: agents[agents.length - 1]?.id }));
  $('#d-input').value = '';
};

// ---------------------------------------------------------------- écran toujours allumé + plein écran
let lock = null;
async function keepAwake() { try { lock = await navigator.wakeLock?.request('screen'); } catch {} }
keepAwake(); document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
$('#d-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
