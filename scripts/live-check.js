// Vérifie la vraie clé API : LLM (appel d'outil) + transcription Whisper + détection du mot « jarvis ».
// Usage : npm run check        (la clé n'est jamais affichée)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';
import { chat, transcribe } from '../server/ai.js';
import { AGENT_TOOLS, SERVER_TOOLS, toOpenAITools } from '../shared/tools.js';
import { findWake } from '../web/js/wake.js';
import { systemPrompt } from '../server/brain.js';

const ai = config.ai;
console.log(`\nFournisseur : ${ai.provider} | chat : ${ai.chatModel} (repli : ${ai.fallbackModels.join(', ') || '—'}) | STT : ${ai.sttModel}`);
if (!ai.key) {
  console.log('✘ Aucune clé API (AI_API_KEY dans .env)\n');
  process.exit(1);
}
const tools = toOpenAITools([...AGENT_TOOLS, ...SERVER_TOOLS]);
console.log(`Schéma des outils : ${tools.length} outils ≈ ${Math.round(JSON.stringify(tools).length / 3.6)} tokens par requête`);

let bad = 0;
const t = async (name, fn) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)${r ? ` — ${r}` : ''}`);
  } catch (e) {
    bad++;
    console.log(`  ✘ ${name} — ${e.message}`);
  }
};

await t('LLM : réponse simple en français', async () => {
  const m = await chat({ messages: [{ role: 'system', content: 'Tu es JARVIS. Réponds en une phrase courte, en français.' }, { role: 'user', content: 'Dis bonjour.' }] });
  if (!m.content) throw new Error('réponse vide');
  return m.content.slice(0, 80);
});

await t('LLM : appel d\'outil (état du système)', async () => {
  const m = await chat({
    messages: [{ role: 'system', content: 'Tu es JARVIS, tu pilotes le PC avec tes outils.' }, { role: 'user', content: 'Combien de RAM libre ai-je sur mon PC ?' }],
    tools,
  });
  const call = m.tool_calls?.[0]?.function?.name;
  if (!call) throw new Error(`aucun appel d'outil (réponse : ${(m.content || '').slice(0, 60)})`);
  return `outil appelé : ${call}`;
});

await t('LLM : outil à risque choisi correctement (suppression)', async () => {
  const sys = systemPrompt('Test', { name: 'PC', os: 'Windows 10', user: 'moi', home: 'C:\\Users\\moi' }, []);
  const m = await chat({
    messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Supprime le fichier C:\\Users\\moi\\Bureau\\vieux.txt' }],
    tools,
  });
  const c = m.tool_calls?.[0]?.function;
  if (!c) throw new Error(`aucun appel d'outil (le modèle a répondu : « ${(m.content || '').slice(0, 120)} »)`);
  return `${c.name} ${c.arguments.slice(0, 70)}`;
});

// Transcription : voix française Windows (SAPI) -> WAV 16 kHz mono -> Whisper
await t('Whisper : « Jarvis, ouvre le bloc-notes » (voix Hortense)', async () => {
  const wav = path.join(os.tmpdir(), `jarvis-live-${Date.now()}.wav`);
  const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; try{$s.SelectVoice('Microsoft Hortense Desktop')}catch{}; ` +
    `$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); ` +
    `$s.SetOutputToWaveFile('${wav}',$f); $s.Speak("Jarvis, ouvre le bloc-notes, s'il te plaît."); $s.Dispose()`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (!fs.existsSync(wav)) throw new Error(`génération audio impossible : ${r.stderr}`);
  const text = await transcribe(fs.readFileSync(wav), 'audio/wav');
  fs.rmSync(wav, { force: true });
  const w = findWake(text);
  if (!w.found) throw new Error(`mot d'activation non détecté dans « ${text} »`);
  return `« ${text} » → commande : « ${w.command} »`;
});

console.log(bad ? `\n${bad} vérification(s) en échec\n` : '\nClé et modèles opérationnels\n');
process.exit(bad ? 1 : 0);
