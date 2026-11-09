import { mountReactor } from './reactor.js';

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
mountReactor($('#orb'));

const params = new URLSearchParams(location.search);
// Redirection après connexion : uniquement vers une page de ce site.
const next = (() => { const n = params.get('next') || '/chat/'; return n.startsWith('/') && !n.startsWith('//') ? n : '/chat/'; })();

let mode = params.get('mode') === 'signup' ? 'register' : 'login';
let cfg = { firstUser: false, inviteRequired: false };

function draw() {
  const reg = mode === 'register';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
  $('#auth-submit').textContent = reg ? 'Créer le compte' : 'Connexion';
  $('#auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#auth-invite').hidden = !(reg && cfg.inviteRequired);
  $('#auth-invite').required = reg && cfg.inviteRequired;
  $('#auth-invite').placeholder = cfg.firstUser ? "Code d'installation" : "Code d'invitation";
  $('#tabs').hidden = cfg.firstUser;
  $('#auth-sub').textContent = cfg.firstUser
    ? "Premier lancement : créez le compte administrateur avec le code d'installation."
    : reg ? (cfg.inviteRequired ? "Création de compte sur invitation : saisissez votre code." : 'Créez votre compte.') : 'Identifiez-vous pour accéder à votre assistant.';
  $('#auth-error').textContent = '';
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { mode = t.dataset.mode; draw(); }));

(async () => {
  // Déjà connecté ? on file directement vers le chat.
  const tok = store.get('jv-token');
  if (tok) {
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${tok}` } });
      if (r.ok) return location.replace(next);
    } catch {}
  }
  try {
    cfg = await (await fetch('/api/config')).json();
    if (cfg.firstUser) mode = 'register';
  } catch { $('#auth-error').textContent = 'Serveur injoignable.'; }
  draw();
})();

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    const body = { username: $('#auth-user').value.trim(), password: $('#auth-pass').value };
    if (mode === 'register') body.invite = $('#auth-invite').value.trim();
    const res = await fetch(mode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Erreur ${res.status}`);
    store.set('jv-token', j.token);
    location.replace(next);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};
