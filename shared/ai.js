// Appels aux fournisseurs IA (API compatible OpenAI : Groq, xAI, Mistral, Gemini, OpenRouter, Cerebras) et, dans le Worker,
// à Cloudflare Workers AI (fournisseur « run » : { provider, run(model, body), chatModel, … }).
// Utilise uniquement fetch/FormData/Blob : fonctionne à l'identique sous Node et dans un Worker Cloudflare.
//
// Robustesse (les modèles et quotas gratuits changent sans cesse) :
//  • plusieurs fournisseurs sont essayés dans l'ordre : quota atteint, clé refusée ou panne => le suivant prend le relais ;
//  • pour chaque fournisseur, la liste réelle des modèles est lue (/models, cache 30 min) : un modèle disparu est ignoré ;
//  • un modèle « introuvable » (404) est écarté 6 h ; un quota (429) met le modèle en pause jusqu'à l'heure de reprise annoncée ;
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
const cooldown = new Map(); // `${provider}|${baseUrl}|${model}` -> timestamp de reprise
const dead = new Map(); // idem -> timestamp du constat
const badKey = new Map(); // `${provider}|${baseUrl}` -> timestamp (clé refusée)

async function liveModels(ai) {
  if (ai.run) return null;
  const hit = modelsCache.get(ai.baseUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids;
  try {
    const r = await fetch(`${ai.baseUrl}/models`, { headers: auth(ai), signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
    const ids = new Set();
    for (const m of ((await r.json()).data || [])) {
      if (m.active === false) continue;
      ids.add(m.id);
      if (String(m.id).startsWith('models/')) ids.add(String(m.id).slice(7)); // Gemini : « models/gemini-… »
    }
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
  const h = Number(res?.headers?.get('retry-after'));
  if (h > 0) return h * 1000;
  const m = /try again in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i.exec(text || '');
  if (m && (m[1] || m[2] || m[3])) return (((+m[1] || 0) * 60 + (+m[2] || 0)) * 60 + (+m[3] || 0)) * 1000;
  return 60_000;
}
const msUntilUtcMidnight = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime(); };

const short = (s) => String(s).replace(/^.*\//, '').replace(/^@cf\//, ''); // « openai/gpt-oss-120b » -> « gpt-oss-120b »
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

/** Uniformise le message de l'assistant (arguments d'outils en JSON texte, identifiants présents, pas de balises de raisonnement). */
function normalize(msg) {
  const out = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '' };
  const calls = (msg.tool_calls || []).map((c, i) => {
    let args = c.function?.arguments ?? c.arguments ?? '{}';
    if (typeof args !== 'string') args = JSON.stringify(args ?? {});
    try {
      const o = JSON.parse(args);
      if (o && typeof o === 'object' && Object.keys(o).length === 1 && '' in o) args = '{}'; // certains modèles renvoient {"": {}} pour « aucun argument »
    } catch {}
    return { id: c.id || `call_${Math.random().toString(36).slice(2, 10)}${i}`, type: 'function', function: { name: c.function?.name ?? c.name, arguments: args } };
  });
  if (calls.length) out.tool_calls = calls;
  return out;
}

// ---------------------------------------------------------------- appels
async function callHttp(ai, model, messages, tools, signal) {
  const body = { model, messages };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (ai.provider === 'groq' && model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
  let res;
  try {
    res = await fetch(`${ai.baseUrl}/chat/completions`, { method: 'POST', headers: { ...auth(ai), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw new AiError('Annulé', 499);
    return { status: 0, text: e.message };
  }
  if (res.ok) return { status: 200, msg: (await res.json()).choices?.[0]?.message };
  const text = errorText(await res.text().catch(() => ''));
  return { status: res.status, text, retryMs: res.status === 429 ? retryAfterMs(res, text) : 0 };
}

async function callRun(ai, model, messages, tools) {
  try {
    const out = await ai.run(model, tools?.length ? { messages, tools } : { messages });
    const msg = out?.choices?.[0]?.message || (out?.response != null ? { content: out.response, tool_calls: out.tool_calls } : null);
    return msg ? { status: 200, msg } : { status: 502, text: 'réponse vide' };
  } catch (e) {
    const t = String(e?.message || e);
    if (/neuron|daily|limit|quota|rate|429|capacity|exceed/i.test(t)) return { status: 429, text: t, retryMs: msUntilUtcMidnight() };
    if (/not found|no such model|unknown model|does not exist/i.test(t)) return { status: 404, text: t };
    return { status: 500, text: t };
  }
}

async function tryProvider(ai, { messages, tools, signal }, vision) {
  const failures = [];
  const live = await liveModels(ai);
  const id = ai.provider;
  const k = (m) => `${id}|${ai.baseUrl || 'run'}|${m}`;
  const now = Date.now();
  if (badKey.get(`${id}|${ai.baseUrl || 'run'}`) > now - 10 * 60 * 1000) return { failures: [{ provider: id, kind: 'clé refusée' }] };

  const base = [...new Set(vision ? [ai.visionModel].filter(Boolean) : [ai.chatModel, ...(ai.fallbackModels || [])].filter(Boolean))];
  let chain = base.filter((m) => !(dead.get(k(m)) > now - DEAD_MS));
  if (live) {
    const present = chain.filter((m) => live.has(m));
    if (present.length) chain = present;
    else if (ai.prefer?.length) { // aucun modèle prévu n'existe : on prend les meilleurs disponibles
      const picks = [];
      for (const pat of ai.prefer) for (const m of live) if (new RegExp(pat).test(m) && !picks.includes(m) && !/embed|moderation|ocr|whisper|tts|guard/i.test(m)) picks.push(m);
      if (picks.length) chain = picks.slice(0, 3).map((m) => m.replace(/^models\//, ''));
    }
  }
  if (!chain.length) chain = base;

  for (const model of chain) {
    if (cooldown.get(k(model)) > now) { failures.push({ provider: id, model, kind: 'quota', ms: cooldown.get(k(model)) - now }); continue; }
    if (signal?.aborted) throw new AiError('Annulé', 499);
    const r = ai.run ? await callRun(ai, model, messages, tools) : await callHttp(ai, model, messages, tools, signal);
    if (r.status === 200 && r.msg) { const msg = normalize(r.msg); msg.via = `${id}/${short(model)}`; return { msg }; }
    if (r.status === 401 || r.status === 403) { badKey.set(`${id}|${ai.baseUrl || 'run'}`, Date.now()); failures.push({ provider: id, model, kind: 'clé refusée' }); break; }
    if (r.status === 429) { cooldown.set(k(model), Date.now() + r.retryMs); failures.push({ provider: id, model, kind: 'quota', ms: r.retryMs }); }
    else if (r.status === 404 || /model_not_found|does not exist/i.test(r.text || '')) {
      dead.set(k(model), Date.now());
      modelsCache.delete(ai.baseUrl);
      failures.push({ provider: id, model, kind: 'absent' });
      console.warn(`[ai] modèle ${id}/${model} introuvable : écarté`);
    } else failures.push({ provider: id, model, kind: r.status ? `erreur ${r.status}` : 'réseau', text: String(r.text || '').slice(0, 140) });
  }
  return { failures };
}

/**
 * Chat completions avec appel d'outils.
 * @param ai  un fournisseur, ou une liste ordonnée de fournisseurs (essayés l'un après l'autre)
 */
export async function chat(ai, { messages, tools, signal }) {
  const list = (Array.isArray(ai) ? ai : [ai]).filter(Boolean);
  if (!list.length) throw new AiError("Aucun fournisseur IA configuré (clé AI_API_KEY manquante).", 503);
  const vision = hasImage(messages);
  const failures = [];
  for (const p of list) {
    const r = await tryProvider(p, { messages, tools, signal }, vision);
    if (r.msg) return r.msg;
    failures.push(...r.failures);
  }
  const names = [...new Set(failures.map((f) => f.provider))];
  if (failures.length && failures.every((f) => f.kind === 'quota' || f.kind === 'clé refusée')) {
    const waits = failures.filter((f) => f.kind === 'quota').map((f) => f.ms);
    if (waits.length) throw new AiError(`Quota gratuit atteint sur tous les fournisseurs IA (${names.join(', ')}). Reprise dans ${fmtWait(Math.min(...waits))}. Astuce : ajoute une clé de secours dans Réglages → Fournisseurs IA.`, 429);
    throw new AiError(`Clé API refusée (${names.join(', ')}).`, 401);
  }
  const detail = failures.map((f) => `${f.provider}${f.model ? `/${short(f.model)}` : ''} : ${f.kind === 'quota' ? `quota atteint (reprise dans ${fmtWait(f.ms)})` : f.kind === 'absent' ? 'modèle indisponible' : `${f.kind}${f.text ? ` — ${f.text}` : ''}`}`).join(' · ');
  throw new AiError(`Aucun modèle n'a pu répondre : ${detail || 'aucun modèle configuré'}`, 502);
}

/** Teste une clé de fournisseur : renvoie le nombre de modèles visibles (lève une AiError si refusée). */
export async function checkKey(ai) {
  const r = await fetch(`${ai.baseUrl}/models`, { headers: auth(ai), signal: AbortSignal.timeout(8000) }).catch((e) => { throw new AiError(`Fournisseur injoignable : ${e.message}`, 502); });
  if (r.status === 401 || r.status === 403) throw new AiError('Clé refusée par le fournisseur.', 400);
  if (!r.ok) throw new AiError(`Le fournisseur a répondu HTTP ${r.status}.`, 502);
  const n = ((await r.json().catch(() => ({}))).data || []).length;
  badKey.delete(`${ai.provider}|${ai.baseUrl}`);
  modelsCache.delete(ai.baseUrl);
  return n;
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
  modelsCache.clear(); cooldown.clear(); dead.clear(); badKey.clear();
}
