// Résolution de la configuration IA (Groq / xAI), partagée entre le serveur Node et le Worker Cloudflare.
// `get(...noms)` renvoie la première valeur non vide parmi des variables d'environnement.

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
    fallbackModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    sttPath: '/audio/transcriptions',
    sttModel: 'whisper-large-v3-turbo',
    sttLanguage: 'fr',
    sttPrompt: true,
  },
};

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
