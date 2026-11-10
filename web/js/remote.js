// Contrôle à distance : voir l'écran du PC, déplacer/cliquer avec la souris (ou le doigt) et taper au clavier.
// Téléphone : le clavier virtuel s'ouvre OBLIGATOIREMENT (champ de saisie toujours re-sélectionné) ; toucher l'écran déplace/clique.
const PRESETS = {
  fluide: { fps: 8, w: 800, q: 45 },
  equilibre: { fps: 5, w: 1100, q: 55 },
  net: { fps: 3, w: 1600, q: 70 },
};
const NAMED = {
  Escape: 'esc', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Delete: 'delete', Insert: 'insert',
};
const BAR = [
  ['Échap', 'esc'], ['Tab', 'tab'], ['Ctrl', 'mod:ctrl'], ['Alt', 'mod:alt'], ['Maj', 'mod:shift'], ['Win', 'mod:win'],
  ['←', 'left'], ['↑', 'up'], ['↓', 'down'], ['→', 'right'], ['Suppr', 'delete'], ['Entrée', 'enter'],
  ['Début', 'home'], ['Fin', 'end'], ['Ctrl+C', 'ctrl+c'], ['Ctrl+V', 'ctrl+v'], ['Ctrl+X', 'ctrl+x'], ['Ctrl+A', 'ctrl+a'],
  ['Ctrl+Z', 'ctrl+z'], ['Alt+Tab', 'alt+tab'], ['F5', 'f5'], ['Win+D', 'win+d'],
];
const SENT = '​'.repeat(8); // caractères « tampon » : le clavier a toujours quelque chose à effacer
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function createRemote({ send, getAgent }) {
  const $ = (id) => document.getElementById(id);
  const root = $('rc'), view = $('rc-view'), img = $('rc-screen'), kbd = $('rc-input'), hint = $('rc-hint'), state = $('rc-state'), wait = $('rc-wait');
  const isTouch = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches;
  let isOpen = false, agentId = null, lastUrl = null;
  let mode = localStorage.getItem('jv-rc-mode') || 'click';
  const mods = { ctrl: false, alt: false, shift: false, win: false };

  const ev = (e) => send({ type: 'rc_input', ev: e });
  const preset = () => PRESETS[$('rc-quality').value] || PRESETS.equilibre;
  const startMsg = () => send({ type: 'rc_start', agentId, opts: preset() });

  // ------------------------------------------------------------ souris / doigt
  let lastMove = 0, pending = null, moveTimer = null;
  function flush() {
    clearTimeout(moveTimer); moveTimer = null;
    if (!pending) return;
    ev({ k: 'm', x: pending[0], y: pending[1] });
    pending = null; lastMove = performance.now();
  }
  function move(x, y, now = false) {
    pending = [x, y];
    if (now || performance.now() - lastMove >= 30) flush();
    else if (!moveTimer) moveTimer = setTimeout(flush, 30);
  }
  const norm = (e) => { const r = img.getBoundingClientRect(); return [clamp01((e.clientX - r.left) / (r.width || 1)), clamp01((e.clientY - r.top) / (r.height || 1))]; };

  const ptrs = new Map();
  let single = null, mouseBtn = null, scrollAcc = 0;
  const avgY = () => [...ptrs.values()].reduce((s, p) => s + p.y, 0) / (ptrs.size || 1);

  view.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    view.setPointerCapture?.(e.pointerId);
    if (e.pointerType === 'mouse') {
      const [x, y] = norm(e);
      move(x, y, true);
      if (e.button === 0 || e.button === 2) { mouseBtn = e.button === 2 ? 'r' : 'l'; ev({ k: 'd', b: mouseBtn }); }
      focusKbd();
      return;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      const [x, y] = norm(e);
      move(x, y, true); // le curseur du PC suit immédiatement le doigt
      single = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, down: false, long: false };
      single.lp = setTimeout(() => {
        if (single && !single.moved && mode === 'click') { single.long = true; ev({ k: 'd', b: 'r' }); ev({ k: 'u', b: 'r' }); navigator.vibrate?.(20); }
      }, 550);
    } else if (single) { // deuxième doigt : défilement
      clearTimeout(single.lp);
      if (single.down) ev({ k: 'u', b: 'l' });
      single = null; scrollAcc = 0;
    }
  });

  view.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { const [x, y] = norm(e); move(x, y); return; }
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size >= 2) {
      const before = avgY();
      p.x = e.clientX; p.y = e.clientY;
      scrollAcc += avgY() - before;
      const steps = Math.trunc(scrollAcc / 22);
      if (steps) { ev({ k: 's', n: steps }); scrollAcc -= steps * 22; }
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (!single || single.id !== e.pointerId) return;
    if (!single.moved && Math.hypot(e.clientX - single.sx, e.clientY - single.sy) > 8) {
      single.moved = true; clearTimeout(single.lp);
      if (mode === 'click' && !single.long) { ev({ k: 'd', b: 'l' }); single.down = true; } // glisser = cliquer-déposer
    }
    if (single.moved || mode === 'move') { const [x, y] = norm(e); move(x, y); }
  });

  function up(e) {
    if (e.pointerType === 'mouse') {
      flush();
      if (mouseBtn) { ev({ k: 'u', b: mouseBtn }); mouseBtn = null; }
      focusKbd();
      return;
    }
    ptrs.delete(e.pointerId);
    if (single && single.id === e.pointerId) {
      clearTimeout(single.lp);
      const [x, y] = norm(e);
      move(x, y, true);
      if (mode === 'click' && !single.long) {
        if (single.down) ev({ k: 'u', b: 'l' });
        else { ev({ k: 'd', b: 'l' }); ev({ k: 'u', b: 'l' }); } // simple toucher = clic gauche à cet endroit
      }
      single = null;
    }
    if (!ptrs.size) scrollAcc = 0;
    focusKbd();
  }
  view.addEventListener('pointerup', up);
  view.addEventListener('pointercancel', up);
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('wheel', (e) => { e.preventDefault(); ev({ k: 's', n: -Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 100)) }); }, { passive: false });

  // ------------------------------------------------------------ clavier
  const anyMod = () => mods.ctrl || mods.alt || mods.shift || mods.win;
  function clearMods() {
    for (const k of Object.keys(mods)) mods[k] = false;
    document.querySelectorAll('#rc-keys .on').forEach((b) => b.classList.remove('on'));
  }
  function sendKey(combo) {
    const parts = [];
    if (mods.ctrl) parts.push('ctrl'); if (mods.alt) parts.push('alt'); if (mods.shift) parts.push('shift'); if (mods.win) parts.push('win');
    parts.push(combo);
    ev({ k: 'p', keys: parts.join('+') });
    clearMods();
  }
  function typeText(t) {
    if (!t) return;
    if (anyMod() && t.length === 1) return sendKey(t.toLowerCase()); // Ctrl collant + « c » = Ctrl+C
    ev({ k: 't', text: t });
  }
  function resetKbd() { kbd.value = SENT; try { kbd.setSelectionRange(SENT.length, SENT.length); } catch {} }
  function focusKbd() {
    if (!isOpen) return;
    try { kbd.focus({ preventScroll: true }); } catch { kbd.focus(); }
    try { kbd.setSelectionRange(kbd.value.length, kbd.value.length); } catch {}
  }

  let lastEnter = 0;
  const enter = () => { const n = performance.now(); if (n - lastEnter > 80) { lastEnter = n; sendKey('enter'); } };

  kbd.addEventListener('beforeinput', (e) => {
    const t = e.inputType || '';
    if (e.isComposing || t.startsWith('insertComposition')) return; // texte « en cours de saisie » : voir compositionupdate
    let handled = true;
    if (t === 'insertText') typeText(e.data ?? '');
    else if (t === 'insertLineBreak' || t === 'insertParagraph') enter();
    else if (t === 'deleteContentBackward') sendKey('backspace');
    else if (t === 'deleteWordBackward') sendKey('ctrl+backspace');
    else if (t === 'deleteContentForward') sendKey('delete');
    else if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertReplacementText') typeText(e.data ?? e.dataTransfer?.getData('text') ?? '');
    else handled = false;
    if (handled) e.preventDefault();
  });

  // Claviers prédictifs (suggestions) : on envoie la différence au fil de l'eau pour que ça reste fluide.
  let comp = '';
  kbd.addEventListener('compositionupdate', (e) => {
    const d = e.data || '';
    let i = 0;
    while (i < comp.length && i < d.length && comp[i] === d[i]) i++;
    for (let k = comp.length - i; k > 0; k--) ev({ k: 'p', keys: 'backspace' });
    if (d.slice(i)) ev({ k: 't', text: d.slice(i) });
    comp = d;
  });
  kbd.addEventListener('compositionend', () => { comp = ''; resetKbd(); });

  kbd.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const k = e.key;
    const mod = e.ctrlKey || e.altKey || e.metaKey;
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl'); if (e.altKey) parts.push('alt'); if (e.metaKey) parts.push('win');
    if (k === 'Enter') { e.preventDefault(); if (mod) sendKey([...parts, 'enter'].join('+')); else enter(); return; }
    const name = NAMED[k] || (/^F\d{1,2}$/.test(k) ? k.toLowerCase() : null);
    if (name) { if (e.shiftKey) parts.push('shift'); sendKey([...parts, name].join('+')); e.preventDefault(); }
    else if (mod && k.length === 1) { if (e.shiftKey) parts.push('shift'); sendKey([...parts, k.toLowerCase()].join('+')); e.preventDefault(); }
  });

  kbd.addEventListener('blur', () => { if (isOpen && isTouch()) hint.hidden = false; });
  kbd.addEventListener('focus', () => { hint.hidden = true; });

  // Barre de touches spéciales (les boutons ne volent pas le focus : le clavier reste ouvert)
  const bar = $('rc-keys');
  for (const [label, key] of BAR) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = 'rc-key';
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (key.startsWith('mod:')) { const m = key.slice(4); mods[m] = !mods[m]; b.classList.toggle('on', mods[m]); }
      else sendKey(key);
      focusKbd();
    });
    bar.append(b);
  }

  // ------------------------------------------------------------ cycle de vie
  function fit() {
    const vv = window.visualViewport;
    root.style.setProperty('--vvh', `${vv ? vv.height : innerHeight}px`);
    root.style.setProperty('--vvt', `${vv ? vv.offsetTop : 0}px`);
  }
  window.visualViewport?.addEventListener('resize', fit);
  window.visualViewport?.addEventListener('scroll', fit);

  function setMode(m) {
    mode = m; localStorage.setItem('jv-rc-mode', m);
    $('rc-mode').textContent = m === 'click' ? 'Toucher = clic' : 'Toucher = déplacer';
  }
  setMode(mode);
  $('rc-mode').onclick = () => setMode(mode === 'click' ? 'move' : 'click');
  $('rc-quality').onchange = () => isOpen && startMsg();
  $('rc-kbd-btn').addEventListener('pointerdown', (e) => e.preventDefault());
  $('rc-kbd-btn').onclick = focusKbd;
  $('rc-close').onclick = () => api.close();
  $('rc-quality').value = isTouch() ? 'fluide' : 'equilibre';

  const api = {
    /** À appeler directement depuis un clic (geste utilisateur) : sinon le clavier du téléphone ne s'ouvre pas. */
    open() {
      const agent = getAgent();
      if (!agent) return false;
      agentId = agent.id;
      isOpen = true;
      root.hidden = false;
      document.body.classList.add('rc-open');
      state.textContent = `${agent.name} — connexion…`;
      wait.textContent = "Connexion à l'écran du PC…"; wait.hidden = false;
      hint.hidden = true;
      fit(); resetKbd(); focusKbd();
      startMsg();
      return true;
    },
    close() {
      if (!isOpen) return;
      send({ type: 'rc_stop' });
      isOpen = false;
      root.hidden = true;
      document.body.classList.remove('rc-open');
      clearMods(); kbd.blur();
      if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
      img.removeAttribute('src');
    },
    onFrame(buf) {
      if (!isOpen) return;
      const u8 = new Uint8Array(buf);
      if (u8[0] !== 1) return;
      const url = URL.createObjectURL(new Blob([u8.subarray(1)], { type: 'image/jpeg' }));
      const old = lastUrl;
      lastUrl = url;
      img.src = url;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 400);
      wait.hidden = true;
      state.textContent = 'en direct';
    },
    onMessage(m) {
      if (!isOpen) return;
      if (m.type === 'rc_error') { wait.textContent = m.message; wait.hidden = false; state.textContent = 'erreur'; }
    },
    onAgents(agents) {
      if (!isOpen) return;
      if (!agents.some((a) => a.id === agentId)) { wait.textContent = 'PC déconnecté…'; wait.hidden = false; state.textContent = 'hors ligne'; }
      else if (state.textContent === 'hors ligne') startMsg();
    },
    onReconnect() { if (isOpen) startMsg(); },
    get isOpen() { return isOpen; },
  };
  return api;
}
