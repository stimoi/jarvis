// Appels au fournisseur IA (API compatible OpenAI : Groq, xAI). Utilise uniquement fetch/FormData/Blob :
// fonctionne à l'identique sous Node et dans un Worker Cloudflare.

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

async function fail(res, what) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {}
  throw new AiError(`${what} (HTTP ${res.status}) ${detail}`.trim(), res.status === 401 ? 401 : 502);
}

const hasImage = (messages) =>
  messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

/** Chat completions avec appel d'outils ; repli automatique sur les modèles suivants (quota, erreur d'outil). */
export async function chat(ai, { messages, tools, signal }) {
  const vision = hasImage(messages);
  const models = vision ? [ai.visionModel] : [ai.chatModel, ...ai.fallbackModels];
  let lastErr;
  for (const model of models) {
    const body = { model, messages };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (ai.provider === 'groq' && model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    const res = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...auth(ai), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) {
      const msg = (await res.json()).choices?.[0]?.message;
      if (!msg) throw new AiError('Réponse du modèle vide');
      return msg;
    }
    const retriable = res.status === 429 || res.status >= 500 || res.status === 400 || res.status === 404;
    try {
      await fail(res, `Erreur ${ai.provider} (chat, ${model})`);
    } catch (e) {
      lastErr = e;
      if (!retriable || model === models[models.length - 1]) throw e;
      console.warn(`[ai] ${model} indisponible (${res.status}), repli sur le modèle suivant`);
    }
  }
  throw lastErr;
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
  if (!res.ok) await fail(res, `Erreur ${ai.provider} (transcription)`);
  const json = await res.json();
  return (json.text ?? '').toString().trim();
}
