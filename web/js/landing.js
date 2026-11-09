import { mountReactor } from './reactor.js';

const $ = (s) => document.querySelector(s);
mountReactor($('#orb'));

// Connecté ? on remplace les boutons de connexion par « Ouvrir le chat ».
let token = null;
try { token = JSON.parse(localStorage.getItem('jv-token')); } catch {}
if (token) {
  $('#nav-login').hidden = true; $('#nav-signup').hidden = true; $('#nav-chat').hidden = false;
  $('#cta-chat').href = '/chat/'; $('#cta-chat').textContent = 'Ouvrir le chat';
} else {
  $('#cta-chat').href = '/auth/?mode=signup';
}

// Démonstration : le réacteur change d'état pendant qu'une commande s'écrit.
const demo = $('#demo');
const script = [
  ['passive', '… en veille'],
  ['listening', '« Jarvis, ouvre mes téléchargements. »'],
  ['thinking', 'analyse de la demande…'],
  ['speaking', "Voilà, monsieur. J'ai ouvert le dossier Téléchargements."],
];
let i = 0;
function step() {
  const [state, text] = script[i % script.length];
  $('#orb').className = `reactor ${state}`;
  let n = 0;
  demo.textContent = '';
  const typer = setInterval(() => {
    demo.textContent = text.slice(0, ++n);
    if (n >= text.length) clearInterval(typer);
  }, 28);
  i++;
  setTimeout(step, 3600);
}
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) step(); else demo.textContent = script[1][1];

// ---------------------------------------------------------------- téléchargement
// Lien direct : /download redirige vers le dernier zip de la Release GitHub (voir scripts/publish-app.js).
(async () => {
  const box = $('#dl');
  try {
    const res = await fetch('/download.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('absent');
    const m = await res.json();
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'panel dl-item';
    d.innerHTML = '<div><div class="caps" style="color:var(--ice)"></div><div class="muted mono"></div></div><a class="btn primary" href="/download" download>Télécharger</a>';
    d.querySelector('.caps').textContent = `JARVIS pour Windows — v${m.version}`;
    d.querySelector('.muted').textContent = `${m.name} · ${(m.size / 1e6).toFixed(0)} Mo · Windows 10/11 64 bits`;
    box.append(d);
    if (m.repo) {
      const src = document.createElement('p');
      src.className = 'muted';
      src.innerHTML = 'Code source : <a target="_blank" rel="noopener"></a>';
      src.querySelector('a').href = `https://github.com/${m.repo}`;
      src.querySelector('a').textContent = `github.com/${m.repo}`;
      box.append(src);
    }
  } catch {
    box.innerHTML = '<div class="panel muted">L\'application arrive bientôt. En attendant, le chat web fonctionne déjà depuis votre navigateur.</div>';
  }
})();
