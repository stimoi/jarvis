// Envoi de messages instantanés par JARVIS : Telegram (bot) et Discord (webhook). Identifiants chiffrés (agent/vault.js).
import { seal, unseal, readAccounts, writeAccounts } from './vault.js';

const TG = () => (process.env.JARVIS_TELEGRAM_BASE || 'https://api.telegram.org').replace(/\/+$/, ''); // variable réservée aux tests
const TOKEN_RE = /^\d{6,12}:[\w-]{30,}$/;
const CHAT_RE = /^(-?\d{4,20}|@[A-Za-z]\w{4,31})$/;
const HOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

export function messagingStatus() {
  const a = readAccounts();
  return { telegram: !!a.telegram?.token, discord: !!a.discord?.url, telegramChat: a.telegram?.chatId || '' };
}

export async function messagingSetup({ telegramToken, telegramChatId, discordUrl, remove }) {
  const all = readAccounts();
  if (remove) { delete all[remove]; writeAccounts(all); return messagingStatus(); }
  if (telegramToken) {
    if (!TOKEN_RE.test(telegramToken)) throw new Error('Jeton Telegram invalide (format 123456789:ABC…, créé avec @BotFather).');
    if (!CHAT_RE.test(String(telegramChatId || ''))) throw new Error("Identifiant de conversation Telegram invalide (nombre, ou @nom pour un canal).");
    const r = await fetch(`${TG()}/bot${telegramToken}/getMe`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Telegram a refusé ce jeton.');
    all.telegram = { token: seal(telegramToken), chatId: String(telegramChatId) };
  }
  if (discordUrl) {
    if (!HOOK_RE.test(discordUrl)) throw new Error("Adresse de webhook Discord invalide (https://discord.com/api/webhooks/…).");
    const r = await fetch(discordUrl, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Discord a refusé ce webhook (supprimé ?).');
    all.discord = { url: seal(discordUrl) };
  }
  writeAccounts(all);
  return messagingStatus();
}

/** Envoie un message sur un canal configuré. */
export async function sendMessage({ channel, text }) {
  const body = String(text || '').trim().slice(0, 1900);
  if (!body) throw new Error('Message vide.');
  const a = readAccounts();
  if (channel === 'telegram') {
    if (!a.telegram?.token) throw new Error("Telegram n'est pas configuré (appli de bureau → Réglages → Messages).");
    const r = await post(`${TG()}/bot${unseal(a.telegram.token)}/sendMessage`, { chat_id: a.telegram.chatId, text: body });
    if (!r.ok) throw new Error(`Telegram : HTTP ${r.status} ${r.text.slice(0, 120)}`);
    return { text: 'Message Telegram envoyé.' };
  }
  if (channel === 'discord') {
    if (!a.discord?.url) throw new Error("Discord n'est pas configuré (appli de bureau → Réglages → Messages).");
    const r = await post(unseal(a.discord.url), { content: body, allowed_mentions: { parse: [] } }); // aucune mention @everyone possible
    if (!r.ok) throw new Error(`Discord : HTTP ${r.status} ${r.text.slice(0, 120)}`);
    return { text: 'Message Discord envoyé.' };
  }
  throw new Error('Canal inconnu (telegram ou discord).');
}
