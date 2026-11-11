// Faux agent PC pour tester l'interface SANS toucher à la vraie souris/clavier ni au vrai PC :
//  • écran à distance : envoie une image de test (grille de coordonnées) et note chaque entrée reçue (JSON-lines) ;
//  • mise à jour : annonce une version (FAKE_VERSION, défaut 0.3.0) ; sur ordre « app_cmd » simule téléchargement -> redémarrage
//    puis se reconnecte avec la nouvelle version (FAKE_NEXT, défaut 0.4.0).
// Usage : node scripts/fake-agent.js <config-agent.json> <fichier-journal> [image.jpg]
import fs from 'node:fs';
import WebSocket from 'ws';

const [cfgFile, logFile, imgFile = 'data/test-screen.jpg'] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const jpeg = fs.readFileSync(imgFile);
const log = (o) => fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`);
let timer = null;
let ws = null;
let version = process.env.FAKE_VERSION || '0.3.0';
const next = process.env.FAKE_NEXT || '0.4.0';
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function connect() {
  ws = new WebSocket(`${cfg.server.replace(/^http/, 'ws')}/ws`, ['jarvis.v1', cfg.token]);
  ws.on('open', () => send({ type: 'hello', info: { name: 'PC-test', os: 'Windows (faux)', user: 'test', home: 'C:\\', tts: false, version, canUpdate: true } }));
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
    else if (m.type === 'app_cmd') {
      log({ t: 'app_cmd', cmd: m.cmd });
      const st = (phase, extra = {}) => send({ type: 'app_status', state: { phase, current: version, latest: next, ...extra } });
      st('checking');
      [[600, 'downloading', { percent: 20 }], [1200, 'downloading', { percent: 65 }], [1800, 'downloading', { percent: 99 }], [2400, 'ready', { percent: 100 }], [3000, 'restarting', {}]].forEach(([ms, phase, ex]) => setTimeout(() => st(phase, ex), ms));
      setTimeout(() => { version = next; ws.close(); }, 3600); // « redémarrage » : l'agent revient avec la nouvelle version
    }
  });
  ws.on('close', () => { clearInterval(timer); setTimeout(connect, 1500); });
}
connect();
setInterval(() => ws?.readyState === 1 && ws.send('ping'), 20000);
