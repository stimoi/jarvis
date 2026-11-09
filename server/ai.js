import { config } from './config.js';
import { chat as sharedChat, transcribe as sharedTranscribe, AiError } from '../shared/ai.js';

export { AiError };
export const chat = (opts) => sharedChat(config.ai, opts);
export const transcribe = (buffer, mime) => sharedTranscribe(config.ai, buffer, mime);
