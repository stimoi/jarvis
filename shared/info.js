// Informations du quotidien pour JARVIS : météo (Open-Meteo, sans clé) et emploi du temps
// (calendrier ICS importé par lien + emploi du temps hebdomadaire saisi à la main).
// Fonctionne sous Node et dans un Worker Cloudflare (fetch + Intl uniquement).

export const DEFAULT_TZ = 'Europe/Paris';
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAY_MS = 86400000;

// ---------------------------------------------------------------- fuseaux horaires
const fmtCache = new Map();
function partsIn(epoch, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(epoch))) o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
const tzOffsetMs = (epoch, tz) => { const p = partsIn(epoch, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(epoch / 1000) * 1000; };
export function wallToEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(t, tz);
}
export const validTz = (tz) => { try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return true; } catch { return false; } };
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (epoch, tz) => { const p = partsIn(epoch, tz); return `${pad(p.h)}:${pad(p.mi)}`; };
/** Jour calendaire (clé AAAA-MM-JJ) d'un instant dans le fuseau. */
export const dayKey = (epoch, tz) => { const p = partsIn(epoch, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const dayStart = (key, tz) => { const [y, m, d] = key.split('-').map(Number); return wallToEpoch(y, m, d, 0, 0, tz); };
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekday = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = dimanche
const dayLabel = (key) => { const [y, m, d] = key.split('-').map(Number); return `${DAYS[weekday(key)]} ${d} ${MONTHS[m - 1]}`; };

// ---------------------------------------------------------------- météo
const WMO = {
  0: 'ciel dégagé', 1: 'plutôt dégagé', 2: 'partiellement nuageux', 3: 'couvert', 45: 'brouillard', 48: 'brouillard givrant',
  51: 'bruine légère', 53: 'bruine', 55: 'bruine forte', 56: 'bruine verglaçante', 57: 'bruine verglaçante forte',
  61: 'pluie faible', 63: 'pluie', 65: 'pluie forte', 66: 'pluie verglaçante', 67: 'pluie verglaçante forte',
  71: 'neige faible', 73: 'neige', 75: 'neige forte', 77: 'grains de neige', 80: 'averses faibles', 81: 'averses', 82: 'averses violentes',
  85: 'averses de neige', 86: 'fortes averses de neige', 95: 'orage', 96: 'orage avec grêle', 99: 'orage violent avec grêle',
};
export const weatherText = (code) => WMO[code] || 'conditions inconnues';
export function weatherIcon(code, day = true) {
  if (code === 0 || code === 1) return day ? '☀️' : '🌙';
  if (code === 2) return day ? '⛅' : '☁️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

async function getJson(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Cherche une ville (Open-Meteo geocoding) : { name, lat, lon, tz, country }. */
export async function geocode(query) {
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=fr&format=json`);
  const r = j.results?.[0];
  if (!r) throw new Error(`Ville introuvable : « ${query} ».`);
  return { name: r.name, lat: r.latitude, lon: r.longitude, tz: r.timezone || DEFAULT_TZ, country: r.country || '' };
}

const weatherCache = new Map();
/** Météo actuelle + 5 jours. Résultat mis en cache 10 minutes. */
export async function fetchWeather({ lat, lon, tz = DEFAULT_TZ }) {
  const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = weatherCache.get(k);
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=${encodeURIComponent(tz)}&forecast_days=5&wind_speed_unit=kmh`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
  const c = j.current;
  const data = {
    now: { temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m), code: c.weather_code, text: weatherText(c.weather_code), isDay: !!c.is_day },
    days: j.daily.time.map((t, i) => ({
      date: t, code: j.daily.weather_code[i], text: weatherText(j.daily.weather_code[i]),
      min: Math.round(j.daily.temperature_2m_min[i]), max: Math.round(j.daily.temperature_2m_max[i]),
      rain: j.daily.precipitation_probability_max?.[i] ?? null, sunrise: j.daily.sunrise[i]?.slice(11, 16), sunset: j.daily.sunset[i]?.slice(11, 16),
    })),
  };
  weatherCache.set(k, { at: Date.now(), data });
  return data;
}

export function weatherSentence(city, w, days = 1) {
  const n = w.now;
  let s = `${city} : ${n.temp} °C (ressenti ${n.feels}), ${n.text}, vent ${n.wind} km/h, humidité ${n.humidity} %.`;
  for (const d of w.days.slice(0, Math.max(1, Math.min(5, days)))) {
    s += ` ${dayLabel(d.date)} : ${d.text}, ${d.min} à ${d.max} °C${d.rain != null ? `, pluie ${d.rain} %` : ''}.`;
  }
  return s;
}

// ---------------------------------------------------------------- ICS
const unesc = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

function parseIcsDate(value, params) {
  // retourne { allDay, y, mo, d, h, mi, utc, tzid }
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const tzid = /TZID=([^;:]+)/i.exec(params || '')?.[1]?.replace(/^"|"$/g, '');
  return { allDay: m[4] === undefined, y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), utc: m[7] === 'Z', tzid };
}

/** Lit un texte ICS : renvoie la liste des événements (sans expansion des répétitions). */
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur?.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i); const val = line.slice(i + 1);
    const name = head.split(';')[0].toUpperCase(); const params = head.slice(name.length);
    if (name === 'DTSTART') cur.start = parseIcsDate(val, params);
    else if (name === 'DTEND') cur.end = parseIcsDate(val, params);
    else if (name === 'DURATION') { const d = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(val); if (d) cur.durMs = (((+d[1] || 0) * 7 + (+d[2] || 0)) * 24 * 60 + (+d[3] || 0) * 60 + (+d[4] || 0)) * 60000; }
    else if (name === 'SUMMARY') cur.title = unesc(val);
    else if (name === 'LOCATION') cur.place = unesc(val);
    else if (name === 'DESCRIPTION') cur.desc = unesc(val).slice(0, 300);
    else if (name === 'STATUS') cur.status = val.trim().toUpperCase();
    else if (name === 'RRULE') cur.rrule = Object.fromEntries(val.split(';').map((p) => p.split('=')).filter((p) => p[1] !== undefined));
    else if (name === 'EXDATE') for (const v of val.split(',')) { const d = parseIcsDate(v, params); if (d) cur.exdates.push(d); }
    else if (name === 'RECURRENCE-ID') cur.recId = parseIcsDate(val, params);
    else if (name === 'UID') cur.uid = val.trim();
  }
  return events;
}

/** Instant d'une date ICS, exprimé en heure locale de l'utilisateur : { key: 'AAAA-MM-JJ', min: minutes depuis minuit }. */
function toLocal(dt, tz) {
  if (dt.allDay) return { key: `${dt.y}-${pad(dt.mo)}-${pad(dt.d)}`, min: 0 };
  let epoch;
  if (dt.utc) epoch = Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi);
  else epoch = wallToEpoch(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.tzid && validTz(dt.tzid) ? dt.tzid : tz);
  const p = partsIn(epoch, tz);
  return { key: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, min: p.h * 60 + p.mi, epoch };
}
const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Occurrences d'un événement ICS qui tombent entre les jours `fromKey` et `toKey` (inclus), en heure locale.
 * Répétitions gérées : DAILY / WEEKLY (BYDAY) / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, EXDATE.
 */
function occurrences(ev, fromKey, toKey, tz) {
  const s = toLocal(ev.start, tz);
  let durMin;
  if (ev.end) { const e = toLocal(ev.end, tz); durMin = ev.start.allDay ? Math.max(1, daysBetween(s.key, e.key)) * 1440 : Math.max(0, Math.round((e.epoch - s.epoch) / 60000)); }
  else if (ev.durMs) durMin = Math.round(ev.durMs / 60000);
  else durMin = ev.start.allDay ? 1440 : 0;
  const out = [];
  const push = (key) => out.push({ key, startMin: s.min, durMin, allDay: !!ev.start.allDay });
  const skip = new Set(ev.exdates.map((d) => toLocal(d, tz).key));
  if (!ev.rrule) {
    // événement simple (éventuellement sur plusieurs jours)
    const span = ev.start.allDay ? Math.max(1, Math.ceil(durMin / 1440)) : Math.max(1, Math.ceil((s.min + durMin) / 1440));
    for (let i = 0; i < span; i++) { const k = addDays(s.key, i); if (k >= fromKey && k <= toKey) out.push({ key: k, startMin: i ? 0 : s.min, durMin: i ? Math.min(durMin, 1440) : durMin, allDay: !!ev.start.allDay, cont: i > 0 }); }
    return out;
  }
  const r = ev.rrule;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? toLocal(parseIcsDate(r.UNTIL, '') || { allDay: true, y: 9999, mo: 1, d: 1 }, tz).key : '9999-12-31';
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => BYDAY[x.slice(-2)]).filter((x) => x !== undefined) : null;
  const freq = r.FREQ;
  const startWd = weekday(s.key);
  const [sy, sm, sd] = s.key.split('-').map(Number);
  let n = 0;
  const last = toKey < until ? toKey : until;
  const total = daysBetween(s.key, last);
  for (let i = 0; i <= total && i < 6000; i++) {
    const k = addDays(s.key, i);
    let hit = false;
    if (freq === 'DAILY') hit = i % interval === 0;
    else if (freq === 'WEEKLY') {
      const wd = weekday(k);
      const weekIdx = Math.floor((i + ((startWd + 6) % 7)) / 7); // semaines (lundi→dimanche) depuis celle du début
      hit = weekIdx % interval === 0 && (byday ? byday.includes(wd) : wd === startWd);
    } else if (freq === 'MONTHLY') {
      const [y, m, d] = k.split('-').map(Number);
      hit = ((y - sy) * 12 + (m - sm)) % interval === 0 && (byday ? false : d === (r.BYMONTHDAY ? Number(r.BYMONTHDAY) : sd));
      if (byday && r.BYDAY) { // ex. 2MO = 2e lundi du mois
        const ord = parseInt(r.BYDAY, 10);
        const wd = BYDAY[r.BYDAY.slice(-2)];
        hit = ((y - sy) * 12 + (m - sm)) % interval === 0 && weekday(k) === wd && (Number.isNaN(ord) || Math.ceil(d / 7) === ord);
      }
    } else if (freq === 'YEARLY') {
      const [y, m, d] = k.split('-').map(Number);
      hit = (y - sy) % interval === 0 && m === sm && d === sd;
    } else break;
    if (!hit) continue;
    n++;
    if (n > count) break;
    if (k >= fromKey && k <= toKey && !skip.has(k)) push(k);
  }
  return out;
}

const icsCache = new Map();
/** Télécharge un calendrier ICS (https uniquement, 3 Mo max, cache 10 min). */
export async function fetchIcs(url) {
  if (!/^https:\/\//i.test(url)) throw new Error('Le lien du calendrier doit commencer par https://');
  const hit = icsCache.get(url);
  if (hit && Date.now() - hit.at < 600000) return hit.text;
  const r = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(10000), headers: { Accept: 'text/calendar,*/*' } });
  if (!r.ok) throw new Error(`Calendrier inaccessible (HTTP ${r.status}).`);
  const text = await r.text();
  if (text.length > 3_000_000) throw new Error('Calendrier trop volumineux.');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Ce lien ne renvoie pas un calendrier au format ICS.");
  icsCache.set(url, { at: Date.now(), text });
  return text;
}

// ---------------------------------------------------------------- emploi du temps
/**
 * Événements entre deux jours (AAAA-MM-JJ inclus), triés : [{ key, start:'HH:MM'|null, end, title, place, allDay, source }].
 * `info.timetable` : [{ day:1..7 (1 = lundi), start:'08:00', end:'09:00', title, place }] ; `icsText` : contenu ICS déjà téléchargé.
 */
export function buildSchedule(info, icsText, fromKey, toKey) {
  const tz = info.tz || DEFAULT_TZ;
  const items = [];
  for (const t of info.timetable || []) {
    const wd = Number(t.day) % 7; // 7 -> 0 (dimanche)
    for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
      if (weekday(k) === wd) items.push({ key: k, start: t.start || null, end: t.end || null, title: t.title, place: t.place || '', allDay: false, source: 'planning' });
    }
  }
  if (icsText) {
    const events = parseIcs(icsText).filter((e) => e.status !== 'CANCELLED');
    const overridden = new Set(events.filter((e) => e.recId).map((e) => `${e.uid}|${toLocal(e.recId, tz).key}`)); // occurrence déplacée : on ignore l'original
    for (const ev of events) {
      for (const o of occurrences(ev, fromKey, toKey, tz)) {
        if (!ev.recId && ev.uid && overridden.has(`${ev.uid}|${o.key}`)) continue;
        const startMin = o.startMin; const endMin = startMin + o.durMin;
        items.push({
          key: o.key, allDay: o.allDay, title: ev.title || '(sans titre)', place: ev.place || '', source: 'agenda',
          start: o.allDay ? null : `${pad(Math.floor(startMin / 60) % 24)}:${pad(startMin % 60)}`,
          end: o.allDay || !o.durMin ? null : `${pad(Math.floor(endMin / 60) % 24)}:${pad(endMin % 60)}`,
        });
      }
    }
  }
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.start || '') < (b.start || '') ? -1 : (a.start || '') > (b.start || '') ? 1 : 0));
  return items;
}

export function scheduleSentence(items, fromKey, toKey, nowEpoch, tz) {
  if (!items.length) return fromKey === toKey ? `Rien de prévu ${dayLabel(fromKey)}.` : 'Rien de prévu sur la période.';
  const today = dayKey(nowEpoch, tz);
  const nowHm = hhmm(nowEpoch, tz);
  const byDay = new Map();
  for (const it of items) byDay.set(it.key, [...(byDay.get(it.key) || []), it]);
  const parts = [];
  for (const [k, list] of byDay) {
    const lines = list.map((it) => {
      const when = it.allDay ? 'toute la journée' : it.end ? `${it.start}-${it.end}` : it.start || '';
      const past = k === today && it.start && (it.end || it.start) < nowHm ? ' (terminé)' : '';
      return `${when} ${it.title}${it.place ? ` (${it.place})` : ''}${past}`.trim();
    });
    parts.push(`${k === today ? "Aujourd'hui" : dayLabel(k)} : ${lines.join(' ; ')}.`);
  }
  return parts.join(' ');
}

/** Prochain événement horaire à partir de maintenant (cherche sur 14 jours). */
export function nextEvent(items, nowEpoch, tz) {
  const today = dayKey(nowEpoch, tz); const nowHm = hhmm(nowEpoch, tz);
  return items.find((it) => !it.allDay && it.start && (it.key > today || (it.key === today && (it.end || it.start) > nowHm))) || null;
}

/** Normalise les paramètres de période d'un outil : date (« today », « demain », AAAA-MM-JJ) + nombre de jours. */
export function resolveRange(args, nowEpoch, tz) {
  const today = dayKey(nowEpoch, tz);
  let from = today;
  const d = String(args.date || 'today').toLowerCase().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) from = d;
  else if (/^(tomorrow|demain)$/.test(d)) from = addDays(today, 1);
  else if (/^(yesterday|hier)$/.test(d)) from = addDays(today, -1);
  const days = Math.max(1, Math.min(14, Number(args.days) || 1));
  return { from, to: addDays(from, days - 1) };
}

// ---------------------------------------------------------------- validation des réglages
/** Nettoie l'emploi du temps saisi à la main. */
export function cleanTimetable(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list.slice(0, 80)) {
    const day = Number(t?.day);
    const ok = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
    if (!(day >= 1 && day <= 7) || !String(t?.title || '').trim() || !ok(t.start)) continue;
    const norm = (s) => { const [h, m] = String(s).split(':'); return `${pad(+h)}:${m}`; };
    out.push({ day, start: norm(t.start), end: ok(t.end) ? norm(t.end) : '', title: String(t.title).trim().slice(0, 80), place: String(t.place || '').trim().slice(0, 60) });
  }
  return out;
}
