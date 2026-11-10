// Faux agent PC pour tester l'interface d'écran à distance SANS toucher à la vraie souris/clavier :
// envoie une image de test (grille de coordonnées) et note chaque entrée reçue dans un fichier JSON-lines.
// Usage : node scripts/fake-agent.js <config-agent.json> <fichier-journal> [image.jpg]
import fs from 'node:fs';
import WebSocket from 'ws';

const [cfgFile, logFile, imgFile = 'data/test-screen.jpg'] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const jpeg = fs.readFileSync(imgFile);
const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`);
let timer = null;

const ws = new WebSocket(`${cfg.server.replace(/^http/, 'ws')}/ws`, ['jarvis.v1', cfg.token]);
const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
ws.on('open', () => send({ type: 'hello', info: { name: 'PC-test', os: 'Windows (faux)', user: 'test', home: 'C:\\', tts: false } }));
ws.on('message', (raw) => {
  const text = raw.toString();
  if (text === 'pong') return;
  const m = JSON.parse(text);
  if (m.type === 'rc_sub') {
    log({ t: 'sub', on: m.on, opts: m.opts });
    clearInterval(timer);
    if (m.on) {
      const frame = () => ws.send(Buffer.concat([Buffer.from([1]), jpeg]), { binary: true });
      frame();
      timer = setInterval(frame, 700);
    }
  } else if (m.type === 'rc_input') log({ t: 'input', ev: m.ev });
});
ws.on('close', () => process.exit(0));
setInterval(() => ws.readyState === 1 && ws.send('ping'), 20000);
