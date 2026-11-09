// Capture micro + détection d'activité vocale (VAD) locale + détection du mot « jarvis ».
// Seuls les segments où quelqu'un parle sont envoyés à la transcription (Whisper/Grok côté serveur).

const TARGET_RATE = 16000;
const FRAME = 320; // 20 ms à 16 kHz
const FRAME_MS = 20;

// ---------- WAV ----------
export function encodeWav(float32, rate = TARGET_RATE) {
  const buf = new ArrayBuffer(44 + float32.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + float32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, float32.length * 2, true);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- Détection du mot d'activation ----------
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ALIASES = new Set(['jarvis', 'jarvice', 'jarvi', 'jarvise', 'jarvisse', 'jarviss', 'jarviz', 'jarvys', 'jarves', 'jarvais', 'djarvis', 'charvis', 'darvis', 'garvis', 'gervais', 'gervis', 'jervis', 'jarwis', 'yarvis', 'harvis', 'jarbis']);

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Cherche « jarvis » (et variantes de transcription) dans les premiers mots. */
export function findWake(text) {
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  let idx = 0;
  while ((m = re.exec(text)) && idx < 5) {
    const t = strip(m[0]);
    if (t.length >= 4 && (ALIASES.has(t) || lev(t, 'jarvis') <= 1)) {
      const command = text.slice(m.index + m[0].length).replace(/^[\s,.:;!?…-]+/, '').trim();
      return { found: true, command };
    }
    idx++;
  }
  return { found: false, command: '' };
}

// Hallucinations typiques de Whisper sur du bruit/silence.
const HALLUC = /^(merci( beaucoup)?( d'avoir regard[ée].*)?|sous-?titr.*|amara\.org.*|à bientôt.*|\.+|…|thanks for watching.*|you)$/i;
export const isHallucination = (t) => HALLUC.test(t.trim().replace(/[!?.]+$/, ''));

// ---------- Capture + VAD ----------
export class VoiceInput {
  /**
   * @param {{onSegment:(blob:Blob,ms:number)=>void, onLevel?:(v:number)=>void}} cb
   */
  constructor(cb) {
    this.cb = cb;
    this.running = false;
    this.paused = false;
    this.endSilenceMs = 750;
    this.minVoicedMs = 320;
    this.maxMs = 20000;
    this.#reset();
  }

  #reset() {
    this.inSpeech = false;
    this.seg = [];
    this.voiced = 0;
    this.silence = 0;
    this.run = 0;
    this.pre = [];
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('/js/worklet.js');
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'tap');
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.src.connect(this.node).connect(mute).connect(this.ctx.destination);

    this.ratio = this.ctx.sampleRate / TARGET_RATE;
    this.acc = 0; this.n = 0; this.pos = 0;
    this.buf = new Float32Array(FRAME * 4);
    this.fill = 0;
    this.noise = 0.006;
    this.level = 0;
    this.node.port.onmessage = (e) => this.#feed(e.data);
    this.running = true;
  }

  stop() {
    this.running = false;
    this.node?.disconnect();
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.#reset();
    this.cb.onLevel?.(0);
  }

  pause(p) {
    this.paused = p;
    if (p) this.#reset();
  }

  // Rééchantillonnage 48k/44.1k -> 16k par moyenne de fenêtre.
  #feed(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      this.acc += chunk[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.buf[this.fill++] = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        if (this.fill === FRAME) {
          this.#frame(this.buf.slice(0, FRAME));
          this.fill = 0;
        }
      }
    }
  }

  #frame(f) {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    const rms = Math.sqrt(s / f.length);
    this.level = this.level * 0.8 + rms * 0.2;
    this.cb.onLevel?.(this.paused ? 0 : this.level);
    if (this.paused) return;

    const speech = rms > Math.max(0.014, this.noise * 3.2);
    if (!this.inSpeech) {
      this.noise = this.noise * 0.97 + rms * 0.03;
      this.pre.push(f);
      if (this.pre.length > 16) this.pre.shift();
      this.run = speech ? this.run + 1 : 0;
      if (this.run >= 3) {
        this.inSpeech = true;
        this.seg = [...this.pre];
        this.voiced = this.run;
        this.silence = 0;
      }
      return;
    }
    this.seg.push(f);
    if (speech) { this.silence = 0; this.voiced++; } else this.silence++;
    if (this.silence * FRAME_MS >= this.endSilenceMs || this.seg.length * FRAME_MS >= this.maxMs) this.#finish();
  }

  #finish() {
    const voicedMs = this.voiced * FRAME_MS;
    const frames = this.seg;
    this.#reset();
    if (voicedMs < this.minVoicedMs) return;
    const out = new Float32Array(frames.length * FRAME);
    frames.forEach((fr, i) => out.set(fr, i * FRAME));
    this.cb.onSegment(encodeWav(out), frames.length * FRAME_MS);
  }
}
