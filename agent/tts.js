// Voix de JARVIS : synthèse neuronale locale (Piper) avec une voix française.
// Piper et les voix se trouvent dans <data>/piper (voir README). Sans eux, l'interface utilise la voix du navigateur.
// Plusieurs voix peuvent être installées (catalogue ci-dessous, téléchargées depuis le dépôt officiel rhasspy/piper-voices) ;
// la voix active est mémorisée dans <data>/piper/voice.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';

const DIR = process.env.JARVIS_PIPER_DIR || path.join(DATA_DIR, 'piper');
const EXE = path.join(DIR, 'piper', 'piper.exe');
const VOICES_DIR = path.join(DIR, 'voices');
// Le dossier de Piper livré avec l'appli peut être en lecture seule : la voix choisie et les voix téléchargées vont dans les données utilisateur.
const USER_DIR = path.join(DATA_DIR, 'piper');
const USER_VOICES = path.join(USER_DIR, 'voices');
const SETTINGS = path.join(USER_DIR, 'voice.json');
const HF = process.env.JARVIS_VOICE_BASE || 'https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR'; // la variable ne sert qu'aux tests

/** Catalogue : `id` = fichier + (éventuellement) `:locuteur`. */
export const VOICE_CATALOG = [
  { id: 'fr_FR-tom-medium', label: 'Tom', desc: 'Masculine, posée et grave (par défaut)', dir: 'tom/medium', mb: 61 },
  { id: 'fr_FR-gilles-low', label: 'Gilles', desc: 'Masculine, plus claire et plus rapide', dir: 'gilles/low', mb: 61 },
  { id: 'fr_FR-upmc-medium:1', label: 'Pierre', desc: 'Masculine, neutre', dir: 'upmc/medium', mb: 74, speaker: 1 },
  { id: 'fr_FR-upmc-medium:0', label: 'Jessica', desc: 'Féminine', dir: 'upmc/medium', mb: 74, speaker: 0 },
  { id: 'fr_FR-siwis-medium', label: 'Siwis', desc: 'Féminine, naturelle', dir: 'siwis/medium', mb: 61 },
];
const byId = (id) => VOICE_CATALOG.find((v) => v.id === id);
const fileOf = (id) => id.split(':')[0];
const locate = (id) => [USER_VOICES, VOICES_DIR].map((d) => path.join(d, `${fileOf(id)}.onnx`)).find((f) => fs.existsSync(f) && fs.existsSync(`${f}.json`)) || null;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; }
}
function currentId() {
  if (process.env.JARVIS_PIPER_VOICE) return null; // chemin imposé par l'environnement
  const id = readSettings().id;
  return id && locate(id) ? id : 'fr_FR-tom-medium';
}
function current() {
  if (process.env.JARVIS_PIPER_VOICE) return { model: process.env.JARVIS_PIPER_VOICE, speaker: null };
  const id = currentId();
  const model = locate(id);
  return { model, speaker: byId(id)?.speaker ?? null };
}

export const ttsAvailable = () => fs.existsSync(EXE) && !!current().model && fs.existsSync(current().model);

// ---------------------------------------------------------------- gestion des voix (appelée depuis le site)
export async function ttsVoices() {
  const cur = currentId();
  const list = VOICE_CATALOG.map((v) => ({ id: v.id, label: v.label, desc: v.desc, mb: v.mb, installed: !!locate(v.id), current: v.id === cur }));
  return { text: JSON.stringify({ piper: fs.existsSync(EXE), current: cur, voices: list, installing: [...installing] }) };
}

export async function ttsSelect({ id }) {
  if (!byId(id)) throw new Error('Voix inconnue.');
  if (!locate(id)) throw new Error("Cette voix n'est pas installée : télécharge-la d'abord.");
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ id }));
  return { text: `Voix active : ${byId(id).label}.` };
}

const installing = new Set();
async function download(url, dest, minBytes) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!r.ok || !r.body) throw new Error(`Téléchargement impossible (HTTP ${r.status}).`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  if (fs.statSync(tmp).size < minBytes) { fs.rmSync(tmp, { force: true }); throw new Error('Fichier incomplet.'); }
  fs.renameSync(tmp, dest);
}

/** Télécharge une voix du catalogue (déclenché par un clic de l'utilisateur sur le site ; adresses fixes, aucune URL libre). */
export async function ttsInstall({ id, select }) {
  const v = byId(id);
  if (!v) throw new Error('Voix inconnue.');
  if (!locate(id)) {
    const f = fileOf(id);
    if (installing.has(f)) throw new Error('Téléchargement déjà en cours.');
    installing.add(f);
    try {
      fs.mkdirSync(USER_VOICES, { recursive: true });
      await download(`${HF}/${v.dir}/${f}.onnx.json`, path.join(USER_VOICES, `${f}.onnx.json`), 500);
      await download(`${HF}/${v.dir}/${f}.onnx`, path.join(USER_VOICES, `${f}.onnx`), 20 * 1024 * 1024);
    } finally {
      installing.delete(f);
    }
  }
  if (select !== false) await ttsSelect({ id });
  return { text: `Voix ${v.label} installée et activée.` };
}

// ---------------------------------------------------------------- synthèse
export async function tts({ text }) {
  if (!ttsAvailable()) throw new Error('Piper non installé sur ce PC.');
  const clean = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!clean) throw new Error('Texte vide');
  const { model, speaker } = current();
  const out = path.join(os.tmpdir(), `jarvis-tts-${crypto.randomBytes(6).toString('hex')}.wav`);
  await new Promise((resolve, reject) => {
    // length_scale < 1 : débit plus rapide ; le client rejoue ensuite un peu plus lentement, ce qui abaisse la hauteur de la voix.
    const args = ['--model', model, '--output_file', out, '--length_scale', '0.86', '--noise_scale', '0.5', '--noise_w', '0.6', '--sentence_silence', '0.15'];
    if (speaker != null) args.push('--speaker', String(speaker));
    const p = spawn(EXE, args, {
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
