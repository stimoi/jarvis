// Appels au fournisseur IA (API compatible OpenAI : Groq, xAI). Utilise uniquement fetch/FormData/Blob :
// fonctionne à l'identique sous Node et dans un Worker Cloudflare.
//
// Robustesse de la chaîne de modèles (les modèles gratuits changent souvent) :
//  • la liste réelle des modèles du compte est lue (/models, cache 30 min) : un modèle disparu est ignoré ;
//  • un modèle qui répond « introuvable » (404) est écarté pendant 6 h ;
//  • un modèle dont le quota est atteint (429) est mis en pause jusqu'à l'heure de reprise annoncée ;
//  • si tout est indisponible, l'erreur dit clairement pourquoi et dans combien de temps réessayer.

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function auth(ai) {
  if (!ai.key) throw new AiError('Clé API manquante (AI_API_KEY).', 503);
  return { Authorization: `Bearer ${ai.key}` };
}

const hasImage = (messages) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

// ---------------------------------------------------------------- état partagé (par processus / isolat)
const CACHE_MS = 30 * 60 * 1000;
const DEAD_MS = 6 * 3600 * 1000;
const modelsCache = new Map(); // baseUrl -> { at, ids:Set|null }
const cooldown = new Map(); // `${baseUrl}|${model}` -> timestamp de reprise
const dead = new Map(); // `${baseUrl}|${model}` -> timestamp du constat

async function liveModels(ai) {
  const hit = modelsCache.get(ai.baseUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids;
  try {
    const r = await fetch(`${ai.baseUrl}/models`, { headers: auth(ai), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
    const ids = new Set(((await r.json()).data || []).filter((m) => m.active !== false).map((m) => m.id));
    if (ids.size) {
      modelsCache.set(ai.baseUrl, { at: Date.now(), ids });
      return ids;
    }
  } catch {}
  modelsCache.set(ai.baseUrl, { at: Date.now() - CACHE_MS + 60_000, ids: null }); // injoignable : on ne réessaie pas avant 1 min
  return null;
}

/** Durée avant reprise, d'après l'en-tête Retry-After ou le texte « Please try again in 7m12.3s ». */
function retryAfterMs(res, text) {
  const h = Number(res.headers.get('retry-after'));
  if (h > 0) return h * 1000;
  const m = /try again in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i.exec(text || '');
  if (m && (m[1] || m[2] || m[3])) return (((+m[1] || 0) * 60 + (+m[2] || 0)) * 60 + (+m[3] || 0)) * 1000;
  return 60_000;
}

const short = (s) => String(s).replace(/^.*\//, ''); // « openai/gpt-oss-120b » -> « gpt-oss-120b »
const fmtWait = (ms) => {
  const min = Math.ceil(ms / 60000);
  return min >= 120 ? `${Math.ceil(min / 60)} h` : min > 1 ? `${min} min` : 'environ 1 min';
};

function errorText(text) {
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text;
  }
}

/** Chat completions avec appel d'outils ; repli automatique sur les modèles suivants. */
export async function chat(ai, { messages, tools, signal }) {
  const vision = hasImage(messages);
  const live = await liveModels(ai);
  const key = (m) => `${ai.baseUrl}|${m}`;
  const now = Date.now();
  const base = [...new Set(vision ? [ai.visionModel] : [ai.chatModel, ...ai.fallbackModels])];
  let chain = base.filter((m) => !(dead.get(key(m)) > now - DEAD_MS));
  if (live) {
    const present = chain.filter((m) => live.has(m));
    if (present.length) chain = present;
  }
  if (!chain.length) chain = base; // tout écarté à tort : on laisse l'API trancher
  const ready = chain.filter((m) => !(cooldown.get(key(m)) > now));

  const failures = [];
  const waits = chain.filter((m) => cooldown.get(key(m)) > now).map((m) => ({ m, ms: cooldown.get(key(m)) - now }));
  for (const w of waits) failures.push({ model: w.m, kind: 'quota', ms: w.ms });

  for (const model of ready) {
    if (signal?.aborted) throw new AiError('Annulé', 499);
    const body = { model, messages };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (ai.provider === 'groq' && model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    let res;
    try {
      res = await fetch(`${ai.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...auth(ai), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new AiError('Annulé', 499);
      failures.push({ model, kind: 'réseau', text: e.message });
      continue;
    }
    if (res.ok) {
      const msg = (await res.json()).choices?.[0]?.message;
      if (!msg) { failures.push({ model, kind: 'vide' }); continue; }
      if (typeof msg.content === 'string') msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(); // raisonnement interne de certains modèles
      return msg;
    }
    const text = errorText(await res.text().catch(() => ''));
    if (res.status === 401) throw new AiError(`Clé API refusée par ${ai.provider} (401).`, 401);
    if (res.status === 429) {
      const ms = retryAfterMs(res, text);
      cooldown.set(key(model), Date.now() + ms);
      failures.push({ model, kind: 'quota', ms });
    } else if (res.status === 404 || /model_not_found|does not exist/i.test(text)) {
      dead.set(key(model), Date.now());
      modelsCache.delete(ai.baseUrl);
      failures.push({ model, kind: 'absent' });
      console.warn(`[ai] modèle ${model} introuvable : écarté`);
    } else {
      failures.push({ model, kind: `erreur ${res.status}`, text: String(text).slice(0, 160) });
    }
  }

  // Tout a échoué : message utile
  if (failures.length && failures.every((f) => f.kind === 'quota')) {
    const ms = Math.min(...failures.map((f) => f.ms));
    throw new AiError(`Quota gratuit ${ai.provider} atteint sur tous les modèles (${failures.map((f) => short(f.model)).join(', ')}). Reprise dans ${fmtWait(ms)}.`, 429);
  }
  const detail = failures.map((f) => `${short(f.model)} : ${f.kind === 'quota' ? `quota atteint (reprise dans ${fmtWait(f.ms)})` : f.kind === 'absent' ? 'modèle indisponible' : `${f.kind}${f.text ? ` — ${f.text}` : ''}`}`).join(' · ');
  throw new AiError(`Aucun modèle n'a pu répondre : ${detail || 'aucun modèle configuré'}`, 502);
}

/** Transcription : audio -> texte. */
export async function transcribe(ai, buffer, mime = 'audio/wav') {
  const ext = mime.includes('wav') ? 'wav' : mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'mp3';
  const form = new FormData();
  form.append('model', ai.sttModel);
  if (ai.sttLanguage) form.append('language', ai.sttLanguage);
  if (ai.sttPrompt) {
    form.append('prompt', 'Jarvis, ouvre le navigateur. Jarvis, quelle heure est-il ?');
    form.append('temperature', '0');
    form.append('response_format', 'json');
  }
  form.append('file', new Blob([buffer], { type: mime }), `audio.${ext}`);
  const res = await fetch(`${ai.baseUrl}${ai.sttPath}`, { method: 'POST', headers: auth(ai), body: form });
  if (!res.ok) {
    const text = errorText(await res.text().catch(() => ''));
    if (res.status === 429) throw new AiError(`Quota de transcription ${ai.provider} atteint. Reprise dans ${fmtWait(retryAfterMs(res, text))}.`, 429);
    throw new AiError(`Erreur ${ai.provider} (transcription, HTTP ${res.status}) ${String(text).slice(0, 200)}`.trim(), res.status === 401 ? 401 : 502);
  }
  const json = await res.json();
  return (json.text ?? '').toString().trim();
}

/** Pour les tests : remet à zéro les caches. */
export function _resetAiState() {
  modelsCache.clear(); cooldown.clear(); dead.clear();
}
