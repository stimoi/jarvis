// Serveur de test du 2e écran : sert web/, fausse /api/dash (vraie météo Open-Meteo + agenda de test) et faux flux WebSocket.
// Usage : node scripts/dash-mock.js [port]   puis ouvrir http://127.0.0.1:<port>/dash/ (jeton de test injecté via /seed)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { geocode, fetchWeather, buildSchedule, nextEvent, dayKey } from '../shared/info.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const port = Number(process.argv[2]) || 8793;
const TZ = 'Europe/Paris';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const now = Date.now();
const today = dayKey(now, TZ);
const ics = (key, s, e, title, place) => `BEGIN:VEVENT\r\nUID:${title}${key}\r\nDTSTART;TZID=Europe/Paris:${key.replace(/-/g, '')}T${s.replace(':', '')}00\r\nDTEND;TZID=Europe/Paris:${key.replace(/-/g, '')}T${e.replace(':', '')}00\r\nSUMMARY:${title}\r\nLOCATION:${place}\r\nEND:VEVENT\r\n`;
const tomorrow = dayKey(now + 86400000, TZ);
const ICS = `BEGIN:VCALENDAR\r\n${ics(today, '08:00', '09:30', 'Maths', 'B204')}${ics(today, '10:00', '11:00', 'Physique', 'Labo 3')}${ics(today, '14:00', '16:00', 'Projet JARVIS', 'Salle info')}${ics(today, '23:00', '23:50', 'Révisions', '')}${ics(tomorrow, '09:00', '10:00', 'Anglais', 'A12')}END:VCALENDAR`;

const geo = await geocode('Lyon');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/seed') { res.setHeader('Content-Type', 'text/html'); return res.end('<script>localStorage.setItem("jv-token", JSON.stringify("test"));location.replace("/dash/")</script>'); }
  if (u.pathname === '/api/mail') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ configured: true, unread: 3, items: [{ uid: 3, from: 'Éloïse Martin <eloise@example.fr>', subject: 'Rendez-vous à 14h demain ?', date: '' }, { uid: 2, from: 'Banque', subject: 'Ton relevé de novembre est disponible', date: '' }, { uid: 1, from: 'newsletter@site.fr', subject: 'Promo −30 % ce week-end', date: '' }] }));
  }
  if (u.pathname === '/api/dash') {
    const items = buildSchedule({ tz: TZ }, ICS, today, dayKey(now + 14 * 86400000, TZ));
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ now: Date.now(), tz: TZ, city: geo.name, weather: await fetchWeather(geo), configured: { city: true, schedule: true }, schedule: { today, tomorrow, items: items.filter((i) => i.key <= tomorrow), next: nextEvent(items, Date.now(), TZ) } }));
  }
  let f = path.join(root, decodeURIComponent(u.pathname));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
  res.end(fs.readFileSync(f));
});
const wss = new WebSocketServer({ server, path: '/ws', handleProtocols: (p) => [...p][0] });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'ready' }));
  ws.send(JSON.stringify({ type: 'state', agents: [{ id: 'a', name: 'PC-de-test', connectedAt: 1 }], busy: false }));
  ws.send(JSON.stringify({ type: 'user_message', text: 'Jarvis, quel temps fait-il ?' }));
  ws.send(JSON.stringify({ type: 'assistant_message', text: 'Lyon : 17 °C, plutôt dégagé. Pluie prévue demain.' }));
  const t = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'stats', stats: { cpu: 10 + Math.round(Math.random() * 40), cores: 8, cpuModel: 'Test', ramUsed: 9e9, ramTotal: 16e9, uptime: 90000, disks: [{ name: 'C:', total: 5e11, free: 2e11 }] } })), 1000);
  ws.on('message', (m) => { const s = m.toString(); if (s !== 'ping') { const j = JSON.parse(s); if (j.type === 'chat') ws.send(JSON.stringify({ type: 'user_message', text: j.text })); } else ws.send('pong'); });
  ws.on('close', () => clearInterval(t));
});
server.listen(port, '127.0.0.1', () => console.log(`2e écran de test : http://127.0.0.1:${port}/seed`));
