// Contrôle à distance : voir l'écran du PC et le piloter (souris + clavier) depuis le site / le téléphone.
// Un processus PowerShell persistant (rc-worker.ps1) capture l'écran et injecte les entrées (SendInput) avec une faible latence.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vkOf } from './tools.js';
import { PAUSE_FILE, audit, loadConfig } from './config.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rc-worker.ps1');
const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

export function createRemote({ sendJson, sendFrame, notify }) {
  let proc = null;
  let buf = Buffer.alloc(0);
  let on = false;
  let idle = null;
  let screen = '';

  const paused = () => fs.existsSync(PAUSE_FILE);
  const write = (line) => proc?.stdin.writable && proc.stdin.write(`${line}\n`);

  function parse(chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) break;
      const type = buf[0];
      const payload = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      if (type === 1) sendFrame(payload);
      else if (type === 2) screen = payload.toString();
      else if (type === 3) console.log('[remote] worker :', payload.toString());
    }
  }

  function ensure() {
    if (proc) return;
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    buf = Buffer.alloc(0);
    proc.stdout.on('data', parse);
    proc.stderr.on('data', (d) => console.log('[remote] stderr :', String(d).trim().slice(-300)));
    proc.stdin.on('error', () => {});
    proc.on('exit', () => {
      proc = null;
      if (on) {
        on = false;
        sendJson({ type: 'rc_error', message: "Le module d'écran à distance s'est arrêté." });
      }
    });
  }

  return {
    /** Active/désactive la diffusion de l'écran (demandé par le hub quand un client regarde). */
    sub(enable, opts = {}) {
      clearTimeout(idle);
      if (!enable) {
        if (on) { audit({ tool: 'remote', decision: 'stop' }); write('C 0'); }
        on = false;
        // le processus reste 30 s en attente (reprise rapide), puis s'arrête
        idle = setTimeout(() => { write('Q'); proc?.kill(); proc = null; }, 30000);
        return;
      }
      if (paused()) return sendJson({ type: 'rc_error', message: 'Contrôle du PC suspendu (interrupteur PAUSE).' });
      if (loadConfig()?.remote === false) return sendJson({ type: 'rc_error', message: 'Le contrôle à distance est désactivé sur ce PC.' });
      const fps = clamp(opts.fps, 1, 10, 5);
      const w = clamp(opts.w, 320, 1920, 1000);
      const q = clamp(opts.q, 20, 85, 55);
      ensure();
      if (!on) {
        audit({ tool: 'remote', decision: 'start', fps, w, q });
        notify?.('Contrôle à distance', "Quelqu'un regarde et pilote cet écran depuis votre compte JARVIS.");
      }
      on = true;
      write(`C 1 ${fps} ${w} ${q}`);
    },

    /** Entrée utilisateur (souris/clavier) envoyée depuis le site. */
    input(ev) {
      if (!on || !proc || paused() || !ev || typeof ev !== 'object') return;
      switch (ev.k) {
        case 'm': {
          const x = Number(ev.x), y = Number(ev.y);
          if (Number.isFinite(x) && Number.isFinite(y)) write(`M ${x.toFixed(5)} ${y.toFixed(5)}`);
          break;
        }
        case 'd': case 'u':
          if (['l', 'r', 'm'].includes(ev.b)) write(`${ev.k === 'd' ? 'D' : 'U'} ${ev.b}`);
          break;
        case 's': write(`S ${clamp(ev.n, -30, 30, 0)}`); break;
        case 't':
          if (typeof ev.text === 'string' && ev.text) write(`T ${Buffer.from(ev.text.slice(0, 500), 'utf8').toString('base64')}`);
          break;
        case 'p': {
          try {
            const vks = String(ev.keys).split('+').map((s) => s.trim()).filter(Boolean).slice(0, 5).map(vkOf);
            if (vks.length) write(`P ${vks.join(',')}`);
          } catch {}
          break;
        }
      }
    },

    stop() {
      clearTimeout(idle);
      if (proc) { write('Q'); proc.kill(); proc = null; }
      on = false;
    },
    get screen() { return screen; },
  };
}
