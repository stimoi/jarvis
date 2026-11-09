// Voix de JARVIS : synthèse neuronale locale (Piper) avec une voix masculine française.
// Piper et le modèle se trouvent dans <data>/piper (voir README). Sans eux, l'interface utilise la voix du navigateur.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';

const DIR = process.env.JARVIS_PIPER_DIR || path.join(DATA_DIR, 'piper');
const EXE = path.join(DIR, 'piper', 'piper.exe');
const VOICE = process.env.JARVIS_PIPER_VOICE || path.join(DIR, 'voices', 'fr_FR-tom-medium.onnx');

export const ttsAvailable = () => fs.existsSync(EXE) && fs.existsSync(VOICE);

export async function tts({ text }) {
  if (!ttsAvailable()) throw new Error('Piper non installé sur ce PC.');
  const clean = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!clean) throw new Error('Texte vide');
  const out = path.join(os.tmpdir(), `jarvis-tts-${crypto.randomBytes(6).toString('hex')}.wav`);
  await new Promise((resolve, reject) => {
    // length_scale < 1 : débit plus rapide ; le client rejoue ensuite un peu plus lentement, ce qui abaisse la hauteur de la voix.
    const p = spawn(EXE, ['--model', VOICE, '--output_file', out, '--length_scale', '0.86', '--noise_scale', '0.5', '--noise_w', '0.6', '--sentence_silence', '0.15'], {
      cwd: path.dirname(EXE),
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { p.kill(); reject(new Error('Piper : délai dépassé')); }, 45000);
    p.on('error', reject);
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Piper code ${code} ${err.slice(-200)}`)); });
    p.stdin.end(clean, 'utf8');
  });
  try {
    return { text: 'Audio généré.', audio: { mime: 'audio/wav', data: fs.readFileSync(out).toString('base64') } };
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}
