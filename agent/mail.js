// Boîte mail de l'utilisateur : lecture (IMAP) et envoi (SMTP), sans dépendance externe (node:tls uniquement).
// Les identifiants sont chiffrés par Windows (agent/vault.js). Les contenus d'e-mails sont des DONNÉES externes, jamais des instructions.
import tls from 'node:tls';
import net from 'node:net';
import { seal, unseal, readAccounts, writeAccounts } from './vault.js';

export const MAIL_PRESETS = {
  gmail: { imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } },
  icloud: { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  yahoo: { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true } },
};
const ADDR_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const ONE_LINE = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

// ---------------------------------------------------------------- décodage MIME
export function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_m, cs, enc, txt) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(/^(utf-?8|us-ascii)$/i.test(cs) ? 'utf-8' : cs.toLowerCase()).decode(bytes);
    } catch { return txt; }
  });
}
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

function parseHeaders(raw) {
  const h = {};
  for (const line of raw.replace(/\r\n[ \t]+/g, ' ').split(/\r\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).toLowerCase()] = (h[line.slice(0, i).toLowerCase()] ?? line.slice(i + 1).trim());
  }
  return h;
}
const param = (v, name) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(v || '')?.slice(1).find(Boolean) || '';
function decodeBody(buf, enc, charset) {
  let bytes = buf;
  const e = String(enc || '').toLowerCase();
  if (e === 'base64') bytes = Buffer.from(buf.toString('latin1').replace(/\s+/g, ''), 'base64');
  else if (e === 'quoted-printable') bytes = Buffer.from(buf.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  try { return new TextDecoder(!charset || /^(utf-?8|us-ascii)$/i.test(charset) ? 'utf-8' : charset.toLowerCase()).decode(bytes); } catch { return bytes.toString('utf8'); }
}
const htmlToText = (h) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/** Extrait le texte d'un message brut (MIME multipart récursif) : { text, attachments:[nom] }. */
export function extractText(rawBuf) {
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  const attachments = [];
  const walk = (buf) => {
    const sep = buf.indexOf('\r\n\r\n');
    const head = parseHeaders(buf.subarray(0, sep < 0 ? buf.length : sep).toString('latin1'));
    const body = sep < 0 ? Buffer.alloc(0) : buf.subarray(sep + 4);
    const ct = head['content-type'] || 'text/plain';
    const dispo = head['content-disposition'] || '';
    if (/^multipart\//i.test(ct)) {
      const b = param(ct, 'boundary');
      const parts = b ? body.toString('latin1').split(`--${b}`).slice(1).filter((p) => !p.startsWith('--')).map((p) => Buffer.from(p.replace(/^\r\n/, '').replace(/\r\n$/, ''), 'latin1')) : [];
      const found = parts.map(walk);
      const plain = found.find((f) => f.kind === 'plain' && f.text.trim());
      return plain || found.find((f) => f.kind === 'html' && f.text.trim()) || { kind: 'none', text: '' };
    }
    const name = decodeWords(param(dispo, 'filename') || param(ct, 'name'));
    if (/^attachment/i.test(dispo) || (name && !/^text\/(plain|html)/i.test(ct))) { attachments.push(name || ct.split(';')[0]); return { kind: 'none', text: '' }; }
    const text = decodeBody(body, head['content-transfer-encoding'], param(ct, 'charset'));
    if (/^text\/html/i.test(ct)) return { kind: 'html', text: htmlToText(text) };
    if (/^text\//i.test(ct)) return { kind: 'plain', text: text.trim() };
    return { kind: 'none', text: '' };
  };
  const r = walk(raw);
  return { text: r.text, attachments };
}

// ---------------------------------------------------------------- client IMAP minimal
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

class Imap {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.n = 0; this.waiter = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const { host, port, secure } = this.cfg;
      const sock = (secure === false ? net : tls).connect({ host, port, servername: host, rejectUnauthorized: true }, () => this.#greet().then(resolve, reject));
      sock.setTimeout(30000, () => sock.destroy(new Error('IMAP : délai dépassé')));
      sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.waiter?.(); });
      sock.on('error', (e) => { this.err = e; this.waiter?.(); reject(e); });
      sock.on('close', () => { this.closed = true; this.waiter?.(); });
      this.sock = sock;
    });
  }
  #wait(pred) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.err) return reject(this.err);
        const r = pred();
        if (r !== null) { this.waiter = null; return resolve(r); }
        if (this.closed) return reject(new Error('IMAP : connexion fermée'));
        this.waiter = check;
      };
      check();
    });
  }
  async #greet() {
    await this.#wait(() => { const i = this.buf.indexOf('\r\n'); return i < 0 ? null : (this.buf = this.buf.subarray(i + 2), true); });
  }
  /** Envoie une commande ; renvoie { status, data:Buffer } (données non étiquetées). */
  async cmd(text) {
    const tag = `A${++this.n}`;
    this.sock.write(`${tag} ${text}\r\n`);
    const resp = await this.#wait(() => {
      // La réponse se termine par une ligne « <tag> OK|NO|BAD » située au début d'une ligne (hors littéraux).
      const s = this.buf.toString('latin1');
      let pos = 0;
      while (pos < s.length) {
        const eol = s.indexOf('\r\n', pos);
        if (eol < 0) return null;
        const line = s.slice(pos, eol);
        if (line.startsWith(`${tag} `)) { const out = { status: /^\S+ (\w+)/.exec(line)[1], text: line, data: this.buf.subarray(0, pos) }; this.buf = this.buf.subarray(eol + 2); return out; }
        const lit = /\{(\d+)\}$/.exec(line);
        pos = eol + 2 + (lit ? Number(lit[1]) : 0);
      }
      return null;
    });
    return resp;
  }
  close() { try { this.sock.write(`A${++this.n} LOGOUT\r\n`); this.sock.end(); } catch {} }
}

async function imapOpen(acc, pass) {
  const c = new Imap(acc.imap);
  await c.connect();
  const r = await c.cmd(`LOGIN ${q(acc.user)} ${q(pass)}`);
  if (r.status !== 'OK') { c.close(); throw new Error(`Connexion refusée par ${acc.imap.host} : ${r.text.replace(/^\S+ \w+ /, '')}. Utilise un mot de passe d'application (pas ton mot de passe habituel).`); }
  return c;
}

/** Découpe les réponses FETCH : [{ uid, flags, header, body }]. */
function parseFetch(data) {
  const s = data.toString('latin1');
  const out = [];
  let pos = 0;
  while (true) {
    const m = /\* (\d+) FETCH \(/g; m.lastIndex = pos;
    const start = m.exec(s);
    if (!start) break;
    // lit jusqu'à la parenthèse fermante finale en sautant les littéraux
    let i = start.index + start[0].length; let depth = 1; const lits = [];
    let head = '';
    while (i < s.length && depth > 0) {
      const ch = s[i];
      if (ch === '{') {
        const e = s.indexOf('}\r\n', i); const n = Number(s.slice(i + 1, e));
        lits.push(data.subarray(e + 3, e + 3 + n)); head += `{#${lits.length - 1}}`; i = e + 3 + n; continue;
      }
      if (ch === '"') { const e = s.indexOf('"', i + 1); head += s.slice(i, e + 1); i = e + 1; continue; }
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (depth > 0) head += ch;
      i++;
    }
    pos = i;
    const uid = Number(/UID (\d+)/.exec(head)?.[1]);
    const flags = /FLAGS \(([^)]*)\)/.exec(head)?.[1] || '';
    const lit = (re) => { const x = re.exec(head); return x ? lits[Number(x[1])] : null; };
    out.push({ uid, flags, header: lit(/HEADER[^{]*\{#(\d+)\}/), body: lit(/BODY\[\](?:<\d+>)?\s*\{#(\d+)\}/) || lit(/BODY\[TEXT\][^{]*\{#(\d+)\}/) });
  }
  return out;
}
const summarize = (m) => {
  const h = parseHeaders((m.header || Buffer.alloc(0)).toString('latin1'));
  return { uid: m.uid, unread: !/\\Seen/.test(m.flags), from: decodeWords(h.from || '').replace(/\s+/g, ' '), subject: decodeWords(h.subject || '(sans objet)'), date: h.date || '' };
};

function creds(secret = 'mail') {
  const a = readAccounts()[secret];
  if (!a?.pass) throw new Error("Boîte mail non configurée. Configure-la dans l'appli de bureau : Réglages → Boîte mail.");
  return { acc: a, pass: unseal(a.pass) };
}

/** Liste les derniers e-mails : { unread:true } pour les non lus ; `from`/`text` pour filtrer. */
export async function mailList({ unread = false, from, text, limit = 8 } = {}) {
  const { acc, pass } = creds();
  const c = await imapOpen(acc, pass);
  try {
    const sel = await c.cmd('EXAMINE INBOX');
    if (sel.status !== 'OK') throw new Error('Boîte de réception inaccessible.');
    const crit = [unread ? 'UNSEEN' : 'ALL', from ? `FROM ${q(from)}` : '', text ? `TEXT ${q(text)}` : ''].filter(Boolean).join(' ');
    const s = await c.cmd(`UID SEARCH ${crit}`);
    const uids = (/\* SEARCH ?([\d ]*)/.exec(s.data.toString('latin1'))?.[1] || '').split(' ').filter(Boolean).map(Number).slice(-Math.max(1, Math.min(20, limit)));
    const total = (/\* (\d+) EXISTS/.exec(sel.data.toString('latin1')) || [])[1];
    if (!uids.length) return { items: [], total: Number(total) || 0 };
    const f = await c.cmd(`UID FETCH ${uids.join(',')} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    return { items: parseFetch(f.data).map(summarize).sort((a, b) => b.uid - a.uid), total: Number(total) || 0 };
  } finally { c.close(); }
}

/** Nombre de non lus + les derniers (pour le 2e écran / le résumé). */
export async function mailSummary() {
  const r = await mailList({ unread: true, limit: 5 });
  return r;
}

export async function mailRead({ uid }) {
  const { acc, pass } = creds();
  const c = await imapOpen(acc, pass);
  try {
    await c.cmd('EXAMINE INBOX');
    const f = await c.cmd(`UID FETCH ${Number(uid)} (UID FLAGS BODY.PEEK[]<0.80000>)`); // PEEK : ne marque pas le message comme lu
    const m = parseFetch(f.data)[0];
    if (!m?.body) throw new Error('Message introuvable.');
    const hdr = parseHeaders(m.body.toString('latin1').split('\r\n\r\n')[0]);
    const { text, attachments } = extractText(m.body);
    return { uid: Number(uid), from: decodeWords(hdr.from || ''), to: decodeWords(hdr.to || ''), subject: decodeWords(hdr.subject || ''), date: hdr.date || '', text: text.slice(0, 6000), attachments };
  } finally { c.close(); }
}

// ---------------------------------------------------------------- SMTP minimal
async function smtpSend(acc, pass, { to, subject, text }) {
  const { host, port, secure } = acc.smtp;
  let sock = await new Promise((resolve, reject) => {
    const s = (secure ? tls : net).connect({ host, port, servername: host, rejectUnauthorized: true }, () => resolve(s));
    s.setTimeout(30000, () => s.destroy(new Error('SMTP : délai dépassé')));
    s.on('error', reject);
  });
  let buf = '';
  let waiter = null;
  const attach = (s) => { s.on('data', (d) => { buf += d.toString('utf8'); waiter?.(); }); s.on('close', () => waiter?.()); };
  attach(sock);
  const reply = () => new Promise((resolve, reject) => {
    const check = () => {
      const lines = buf.split('\r\n');
      const done = lines.findIndex((l) => /^\d{3} /.test(l));
      if (done >= 0) { const code = Number(lines[done].slice(0, 3)); const text = lines.slice(0, done + 1).join('\n'); buf = lines.slice(done + 1).join('\r\n'); waiter = null; return resolve({ code, text }); }
      if (sock.destroyed) return reject(new Error('SMTP : connexion fermée'));
      waiter = check;
    };
    check();
  });
  const cmd = async (line, ok) => { sock.write(`${line}\r\n`); const r = await reply(); if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code} : ${r.text.replace(/\n/g, ' ').slice(0, 200)}`); return r; };
  try {
    const g = await reply(); if (g.code !== 220) throw new Error(`SMTP : accueil inattendu (${g.code})`);
    let ehlo = await cmd('EHLO jarvis.local', [250]);
    if (!secure) {
      if (!/STARTTLS/i.test(ehlo.text) && host !== '127.0.0.1') throw new Error('Le serveur SMTP ne propose pas STARTTLS : envoi refusé (mot de passe non protégé).');
      if (/STARTTLS/i.test(ehlo.text)) {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data');
        sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: true });
        await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
        buf = ''; attach(sock);
        ehlo = await cmd('EHLO jarvis.local', [250]);
      }
    }
    await cmd(`AUTH PLAIN ${Buffer.from(`\0${acc.user}\0${pass}`).toString('base64')}`, [235]);
    await cmd(`MAIL FROM:<${acc.address}>`, [250]);
    await cmd(`RCPT TO:<${to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const msg = [
      `From: ${acc.address}`, `To: ${to}`, `Subject: ${encodeWord(ONE_LINE(subject))}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@jarvis.local>`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(String(text), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
    ].join('\r\n');
    sock.write(`${msg}\r\n.\r\n`);
    const done = await reply(); if (done.code !== 250) throw new Error(`SMTP ${done.code} : ${done.text.slice(0, 200)}`);
    try { sock.write('QUIT\r\n'); sock.end(); } catch {}
  } catch (e) { try { sock.destroy(); } catch {} throw e; }
}

export async function mailSend({ to, subject, body }) {
  const addr = ONE_LINE(to);
  if (!ADDR_RE.test(addr)) throw new Error(`Adresse invalide : « ${addr} ».`);
  const { acc, pass } = creds();
  await smtpSend(acc, pass, { to: addr, subject: subject || '(sans objet)', text: body || '' });
  return { sent: true, to: addr };
}

// ---------------------------------------------------------------- configuration (depuis l'appli de bureau)
export function mailStatus() {
  const a = readAccounts().mail;
  return a ? { configured: true, address: a.address, imap: a.imap.host, smtp: a.smtp.host } : { configured: false };
}
export async function mailSetup({ preset, address, password, imap, smtp }) {
  const base = MAIL_PRESETS[preset] || { imap, smtp };
  const addr = ONE_LINE(address);
  if (!ADDR_RE.test(addr)) throw new Error('Adresse e-mail invalide.');
  if (!password || String(password).length < 4) throw new Error("Mot de passe d'application manquant.");
  const norm = (x) => ({ host: String(x?.host || '').trim(), port: Number(x?.port) || 0, secure: x?.secure !== false });
  const acc = { address: addr, user: addr, imap: norm(base.imap), smtp: norm(base.smtp) };
  if (!acc.imap.host || !acc.imap.port || !acc.smtp.host || !acc.smtp.port) throw new Error('Serveurs IMAP / SMTP incomplets.');
  // Test réel avant d'enregistrer : un mauvais mot de passe est signalé tout de suite.
  const c = await imapOpen(acc, String(password));
  c.close();
  acc.pass = seal(String(password));
  const all = readAccounts(); all.mail = acc; writeAccounts(all);
  return mailStatus();
}
export function mailRemove() {
  const all = readAccounts(); delete all.mail; writeAccounts(all);
  return { configured: false };
}
