// Résolution de la configuration IA, partagée entre le serveur Node et le Worker Cloudflare.
// `get(...noms)` renvoie la première valeur non vide parmi des variables d'environnement.
//
// Fournisseur principal (clé AI_API_KEY) : Groq (gsk_…) ou xAI (xai-…).
// Fournisseurs de SECOURS (clé à ajouter, gratuits ou à essai) : essayés dans l'ordre quand le principal est en quota.
// En dernier recours, dans le Worker : Cloudflare Workers AI (aucune clé, quota gratuit quotidien).

const PROVIDERS = {
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    chatModel: 'grok-4.7',
    fallbackModels: [],
    visionModel: '',
    sttPath: '/stt',
    sttModel: 'grok-voice-transcribe-2.0',
    sttLanguage: '',
    sttPrompt: false,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    chatModel: 'openai/gpt-oss-120b',
    fallbackModels: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    visionModel: 'qwen/qwen3.8-27b',
    sttPath: '/audio/transcriptions',
    sttModel: 'whisper-large-v3-turbo',
    sttLanguage: 'fr',
    sttPrompt: true,
  },
};

/** Fournisseurs de secours compatibles API OpenAI. `prefer` : motifs pour choisir parmi les modèles réellement disponibles. */
export const FALLBACKS = {
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    env: ['MISTRAL_API_KEY'],
    chat: ['mistral-small-latest', 'open-mistral-nemo'],
    vision: ['mistral-small-latest'],
    prefer: ['^mistral-small', '^mistral-medium', '^open-mistral-nemo', '^ministral'],
    signup: 'https://console.mistral.ai/api-keys',
    note: "Plan gratuit « Expérimentation » (≈ 1 requête/s, très gros volume mensuel), vérification par téléphone. Les requêtes peuvent servir à entraîner leurs modèles.",
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    chat: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    vision: ['gemini-2.5-flash-lite'],
    prefer: ['flash-lite', 'flash'],
    signup: 'https://aistudio.google.com/apikey',
    note: 'Clé immédiate, gratuit mais quotas variables (quelques dizaines à centaines de requêtes/jour).',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    chat: ['openai/gpt-oss-20b:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    vision: [],
    prefer: [':free$'],
    signup: 'https://openrouter.ai/keys',
    note: 'Modèles « :free » : environ 50 requêtes/jour sans crédit (1000 avec 10 $ de crédit).',
  },
  cerebras: {
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    env: ['CEREBRAS_API_KEY'],
    chat: ['gpt-oss-120b', 'llama-3.3-70b', 'qwen-3-32b'],
    vision: [],
    prefer: ['gpt-oss', 'llama', 'qwen'],
    signup: 'https://cloud.cerebras.ai',
    note: "Très rapide ; crédit d'essai puis payant (carte demandée).",
  },
};
export const FALLBACK_ORDER = ['mistral', 'gemini', 'openrouter', 'cerebras'];

export function resolveAi(get, settings = {}) {
  const key = settings.apiKey || get('AI_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY');
  const forced = get('AI_PROVIDER').toLowerCase();
  const provider = PROVIDERS[forced] ? forced : key.startsWith('gsk_') ? 'groq' : 'xai';
  const d = PROVIDERS[provider];
  const chatModel = settings.chatModel || get('AI_CHAT_MODEL', 'XAI_CHAT_MODEL') || d.chatModel;
  const fb = get('AI_FALLBACK_MODELS');
  const sttLang = get('AI_STT_LANGUAGE');
  return {
    provider,
    key,
    baseUrl: (get('AI_BASE_URL', 'XAI_BASE_URL') || d.baseUrl).replace(/\/+$/, ''),
    chatModel,
    fallbackModels: fb ? fb.split(',').map((m) => m.trim()).filter(Boolean) : d.fallbackModels,
    visionModel: get('AI_VISION_MODEL') || d.visionModel || chatModel,
    sttPath: d.sttPath,
    sttModel: get('AI_STT_MODEL', 'XAI_STT_MODEL') || d.sttModel,
    sttLanguage: sttLang || d.sttLanguage,
    sttPrompt: d.sttPrompt,
  };
}

/** Configuration d'un fournisseur de secours à partir de sa clé. */
export function fallbackConfig(id, key) {
  const f = FALLBACKS[id];
  return {
    provider: id,
    key,
    baseUrl: f.baseUrl,
    chatModel: f.chat[0],
    fallbackModels: f.chat.slice(1),
    visionModel: f.vision[0] || '',
    prefer: f.prefer,
  };
}

/**
 * Liste ordonnée des fournisseurs utilisables : principal puis secours dont une clé existe
 * (`stored` : clés saisies dans l'appli {id: clé} ; sinon variables d'environnement MISTRAL_API_KEY…).
 */
export function resolveProviders(get, stored = {}, settings = {}) {
  const primary = resolveAi(get, settings);
  const list = primary.key ? [primary] : [];
  for (const id of FALLBACK_ORDER) {
    const key = stored[id] || get(...FALLBACKS[id].env);
    if (key) list.push(fallbackConfig(id, key));
  }
  return list;
}
