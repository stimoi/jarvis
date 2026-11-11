// Tests de shared/info.js (emploi du temps ICS + planning manuel + météo) : npm run test:info
import assert from 'node:assert/strict';
import { parseIcs, buildSchedule, scheduleSentence, nextEvent, resolveRange, cleanTimetable, wallToEpoch, dayKey, weatherText } from '../shared/info.js';

const TZ = 'Europe/Paris';
let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`  ✔ ${name}`); } catch (e) { failures++; console.log(`  ✘ ${name}\n      ${e.message}`); } };

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  // cours hebdo le lundi et le mercredi 08:00-10:00 (heure de Paris), jusqu'au 30 novembre, sauf le 18 novembre... (mercredi)
  'BEGIN:VEVENT', 'UID:maths', 'DTSTART;TZID=Europe/Paris:20261102T080000', 'DTEND;TZID=Europe/Paris:20261102T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261130T230000Z', 'EXDATE;TZID=Europe/Paris:20261118T080000', 'SUMMARY:Maths\\, salle 12', 'LOCATION:B204', 'END:VEVENT',
  // occurrence unique en UTC : 14:30Z = 15:30 à Paris en novembre
  'BEGIN:VEVENT', 'UID:rdv', 'DTSTART:20261111T143000Z', 'DTEND:20261111T153000Z', 'SUMMARY:Rendez-vous dentiste', 'END:VEVENT',
  // journée entière
  'BEGIN:VEVENT', 'UID:ferie', 'DTSTART;VALUE=DATE:20261111', 'DTEND;VALUE=DATE:20261112', 'SUMMARY:Armistice', 'END:VEVENT',
  // annulé : ignoré
  'BEGIN:VEVENT', 'UID:x', 'DTSTART:20261111T100000Z', 'DTEND:20261111T110000Z', 'SUMMARY:Annulé', 'STATUS:CANCELLED', 'END:VEVENT',
  // toutes les 2 semaines le jeudi, 3 occurrences
  'BEGIN:VEVENT', 'UID:club', 'DTSTART;TZID=Europe/Paris:20261105T180000', 'DURATION:PT1H30M', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3', 'SUMMARY:Club', 'END:VEVENT',
  // ligne repliée
  'BEGIN:VEVENT', 'UID:long', 'DTSTART;TZID=Europe/Paris:20261112T120000', 'DTEND;TZID=Europe/Paris:20261112T130000', 'SUMMARY:Déjeuner très long', ' avec suite', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

console.log('\nInfos (agenda, emploi du temps, météo)\n');

test('parseIcs : événements, lignes repliées, échappements', () => {
  const ev = parseIcs(ICS);
  assert.equal(ev.length, 6);
  assert.equal(ev.find((e) => e.uid === 'maths').title, 'Maths, salle 12');
  assert.equal(ev.find((e) => e.uid === 'long').title, 'Déjeuner très longavec suite');
});

test('wallToEpoch : heure d’été / d’hiver (Paris)', () => {
  assert.equal(new Date(wallToEpoch(2026, 7, 1, 12, 0, TZ)).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(new Date(wallToEpoch(2026, 11, 11, 12, 0, TZ)).toISOString(), '2026-11-11T11:00:00.000Z');
});

test('hebdo BYDAY + EXDATE + UNTIL', () => {
  const s = buildSchedule({ tz: TZ }, ICS, '2026-11-01', '2026-12-31').filter((e) => e.title.startsWith('Maths')).map((e) => e.key);
  assert.deepEqual(s, ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11', '2026-11-16', '2026-11-23', '2026-11-25', '2026-11-30']); // 18/11 exclu, rien après le 30
});

test('événement UTC converti en heure locale, annulé ignoré, journée entière', () => {
  const day = buildSchedule({ tz: TZ }, ICS, '2026-11-11', '2026-11-11');
  const rdv = day.find((e) => e.title.startsWith('Rendez-vous'));
  assert.equal(rdv.start, '15:30'); assert.equal(rdv.end, '16:30');
  assert.ok(!day.some((e) => e.title === 'Annulé'));
  assert.ok(day.find((e) => e.title === 'Armistice').allDay);
  assert.ok(day.find((e) => e.title.startsWith('Maths')).start === '08:00');
});

test('INTERVAL=2 + COUNT=3 + DURATION', () => {
  const s = buildSchedule({ tz: TZ }, ICS, '2026-11-01', '2027-01-31').filter((e) => e.title === 'Club');
  assert.deepEqual(s.map((e) => e.key), ['2026-11-05', '2026-11-19', '2026-12-03']);
  assert.equal(s[0].end, '19:30');
});

test('planning manuel hebdomadaire (lundi = 1, dimanche = 7) + tri par heure', () => {
  const tt = cleanTimetable([{ day: 1, start: '14:00', end: '15:00', title: 'Anglais' }, { day: 1, start: '8:00', end: '9:30', title: 'Sport', place: 'Gymnase' }, { day: 9, start: '08:00', title: 'invalide' }, { day: 7, start: '10:00', title: 'Dimanche' }]);
  assert.equal(tt.length, 3);
  const s = buildSchedule({ tz: TZ, timetable: tt }, '', '2026-11-08', '2026-11-09'); // dimanche 8, lundi 9
  assert.deepEqual(s.map((e) => `${e.key} ${e.start} ${e.title}`), ['2026-11-08 10:00 Dimanche', '2026-11-09 08:00 Sport', '2026-11-09 14:00 Anglais']);
});

test('phrases lues à voix haute + prochain événement', () => {
  const now = Date.parse('2026-11-11T09:30:00Z'); // 10:30 à Paris
  const items = buildSchedule({ tz: TZ }, ICS, '2026-11-11', '2026-11-11');
  const txt = scheduleSentence(items, '2026-11-11', '2026-11-11', now, TZ);
  assert.match(txt, /^Aujourd'hui : /);
  assert.match(txt, /08:00-10:00 Maths, salle 12 \(B204\) \(terminé\)/);
  assert.match(txt, /15:30-16:30 Rendez-vous dentiste/);
  assert.equal(nextEvent(items, now, TZ).title, 'Rendez-vous dentiste');
  assert.match(scheduleSentence([], '2026-11-12', '2026-11-12', now, TZ), /Rien de prévu jeudi 12 novembre/);
});

test('resolveRange : aujourd’hui / demain / date / nombre de jours borné', () => {
  const now = Date.parse('2026-11-11T22:30:00Z'); // 23:30 à Paris : toujours le 11
  assert.deepEqual(resolveRange({}, now, TZ), { from: '2026-11-11', to: '2026-11-11' });
  assert.deepEqual(resolveRange({ date: 'demain', days: 3 }, now, TZ), { from: '2026-11-12', to: '2026-11-14' });
  assert.deepEqual(resolveRange({ date: '2026-12-24', days: 99 }, now, TZ), { from: '2026-12-24', to: '2027-01-06' });
  assert.equal(dayKey(now, TZ), '2026-11-11');
});

test('codes météo', () => {
  assert.equal(weatherText(61), 'pluie faible');
  assert.equal(weatherText(999), 'conditions inconnues');
});

console.log(failures ? `\n${failures} échec(s)\n` : '\nTout est OK\n');
process.exit(failures ? 1 : 0);
