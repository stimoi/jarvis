// Infos du quotidien côté Worker : réglages (ville, calendrier ICS, emploi du temps) en D1, outils JARVIS, données du 2e écran.
import { DEFAULT_TZ, validTz, geocode, fetchWeather, weatherSentence, fetchIcs, parseIcs, buildSchedule, scheduleSentence, nextEvent, resolveRange, cleanTimetable, dayKey } from '../../shared/info.js';

const KEY = 'info';

export async function loadInfo(env) {
  const row = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(KEY).first();
  try {
    return row?.v ? JSON.parse(row.v) : {};
  } catch {
    return {};
  }
}
const store = (env, info) => env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(KEY, JSON.stringify(info)).run();

/** Vue publique des réglages (le lien ICS est secret : seul un indice est renvoyé). */
export function publicInfo(info) {
  return {
    city: info.city || '', tz: info.tz || DEFAULT_TZ, hasIcs: !!info.icsUrl, icsHint: info.icsUrl ? `…${info.icsUrl.slice(-6)}` : '',
    timetable: info.timetable || [],
  };
}

/** Enregistre les réglages envoyés par l'admin ; vérifie la ville et le calendrier avant d'accepter. */
export async function saveInfo(env, b) {
  const info = await loadInfo(env);
  const notes = [];
  if (typeof b.city === 'string') {
    const name = b.city.trim();
    if (!name) { delete info.city; delete info.lat; delete info.lon; }
    else if (name !== info.city) {
      const g = await geocode(name);
      Object.assign(info, { city: g.name, lat: g.lat, lon: g.lon });
      if (!b.tz && g.tz) info.tz = g.tz;
      notes.push(`Ville : ${g.name}${g.country ? ` (${g.country})` : ''}`);
    }
  }
  if (typeof b.tz === 'string' && b.tz.trim()) {
    if (!validTz(b.tz.trim())) throw Object.assign(new Error('Fuseau horaire inconnu (ex. Europe/Paris).'), { status: 400 });
    info.tz = b.tz.trim();
  }
  if (typeof b.icsUrl === 'string') {
    const url = b.icsUrl.trim();
    if (!url) { delete info.icsUrl; notes.push('Calendrier retiré'); }
    else if (url !== info.icsUrl) {
      const text = await fetchIcs(url).catch((e) => { throw Object.assign(e, { status: 400 }); });
      info.icsUrl = url.replace(/^webcal:/i, 'https:');
      notes.push(`Calendrier : ${parseIcs(text).length} événements`);
    }
  }
  if (Array.isArray(b.timetable)) { info.timetable = cleanTimetable(b.timetable); notes.push(`Emploi du temps : ${info.timetable.length} créneaux`); }
  await store(env, info);
  return { info: publicInfo(info), notes };
}

async function icsText(info) {
  if (!info.icsUrl) return '';
  try {
    return await fetchIcs(info.icsUrl);
  } catch (e) {
    console.error('ics', e.message);
    return '';
  }
}

const cityOf = (info) => (info.lat != null ? { lat: info.lat, lon: info.lon, tz: info.tz || DEFAULT_TZ } : null);

/** Exécute get_weather / get_schedule. */
export async function infoTool(env, name, args) {
  const info = await loadInfo(env);
  const tz = info.tz || DEFAULT_TZ;
  const now = Date.now();
  if (name === 'get_weather') {
    let place = cityOf(info); let label = info.city;
    if (args.city && String(args.city).trim().toLowerCase() !== String(info.city || '').toLowerCase()) {
      const g = await geocode(String(args.city).trim());
      place = { lat: g.lat, lon: g.lon, tz: g.tz }; label = g.name;
    }
    if (!place) return "Aucune ville configurée : demande à l'utilisateur sa ville (Réglages → Infos du quotidien) ou précise une ville.";
    return weatherSentence(label, await fetchWeather(place), Number(args.days) || 1);
  }
  if (name === 'get_schedule') {
    if (!info.icsUrl && !info.timetable?.length) return "Aucun emploi du temps configuré (Réglages → Infos du quotidien : lien de calendrier ICS ou planning hebdomadaire).";
    const { from, to } = resolveRange(args, now, tz);
    const text = await icsText(info);
    const items = buildSchedule(info, text, from, to);
    let out = scheduleSentence(items, from, to, now, tz);
    const upcoming = nextEvent(buildSchedule(info, text, dayKey(now, tz), dayKey(now + 14 * 86400000, tz)), now, tz);
    if (upcoming) out += ` Prochain : ${upcoming.start} ${upcoming.title}${upcoming.place ? ` (${upcoming.place})` : ''}${upcoming.key !== dayKey(now, tz) ? `, le ${upcoming.key}` : ''}.`;
    return out;
  }
  return `Outil inconnu : ${name}`;
}

/** Données du 2e écran : météo + agenda aujourd'hui / demain + prochain événement. Chaque bloc échoue séparément. */
export async function dashData(env) {
  const info = await loadInfo(env);
  const tz = info.tz || DEFAULT_TZ;
  const now = Date.now();
  const out = { now, tz, city: info.city || '', weather: null, schedule: null, configured: { city: !!cityOf(info), schedule: !!(info.icsUrl || info.timetable?.length) } };
  const place = cityOf(info);
  await Promise.all([
    (async () => { if (place) try { out.weather = await fetchWeather(place); } catch (e) { out.weatherError = e.message; } })(),
    (async () => {
      if (!out.configured.schedule) return;
      const today = dayKey(now, tz);
      const items = buildSchedule(info, await icsText(info), today, dayKey(now + 14 * 86400000, tz));
      out.schedule = { today, tomorrow: dayKey(now + 86400000, tz), items: items.filter((i) => i.key <= dayKey(now + 86400000, tz)), next: nextEvent(items, now, tz) };
    })().catch((e) => { out.scheduleError = e.message; }),
  ]);
  return out;
}
