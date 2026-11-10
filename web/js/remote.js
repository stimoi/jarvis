// Écran à distance : voir le PC en direct, zoomer, déplacer la souris, cliquer et taper — pensé pour le téléphone.
//  • Affichage : ajuster / remplir / ×2-×4, pincer pour zoomer, deux doigts pour déplacer la vue, plein écran + paysage.
//  • Souris    : « Direct » (toucher = cliquer), « Viser » (le curseur reste, boutons de clic), « Pavé tactile » (relatif).
//  • Clavier   : clavier JARVIS (AZERTY, accents, F1-F12, raccourcis) ou clavier du téléphone, ou masqué (clavier physique).
import { createKeyboard } from './keyboard.js';

const PRESETS = {
  fluide: { fps: 8, w: 800, q: 45 },
  equilibre: { fps: 5, w: 1100, q: 55 },
  net: { fps: 3, w: 1600, q: 70 },
};
const NAMED = {
  Escape: 'esc', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Delete: 'delete', Insert: 'insert',
};
const QUICK = [
  ['Échap', 'esc'], ['Tab', 'tab'], ['Ctrl', 'mod:ctrl'], ['Alt', 'mod:alt'], ['Maj', 'mod:shift'], ['Win', 'mod:win'],
  ['←', 'left'], ['↑', 'up'], ['↓', 'down'], ['→', 'right'], ['Suppr', 'delete'], ['Entrée', 'enter'],
  ['Ctrl+C', 'ctrl+c'], ['Ctrl+V', 'ctrl+v'], ['Ctrl+A', 'ctrl+a'], ['Ctrl+Z', 'ctrl+z'], ['Alt+Tab', 'alt+tab'], ['Win+D', 'win+d'],
];
const SENT = '​'.repeat(8); // tampon : le clavier du téléphone a toujours quelque chose à effacer
const AIM_OFFSET = 60; // mode « Viser » : la cible est décalée au-dessus du doigt pour ne pas être cachée
const EDGE = 46;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEFAULTS = { mode: 'direct', quality: 'auto', kbd: null, kbSize: 'm', lefty: false, pad: 1.6, lock: false, autoLand: true, kbAuto: true };
const loadPrefs = () => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('jv-rc') || '{}') }; } catch { return { ...DEFAULTS }; } };

const SHEET = [
  { t: 'Souris', k: 'mode', o: [['direct', 'Direct'], ['aim', 'Viser'], ['pad', 'Pavé tactile']], d: 'Direct : toucher = cliquer · Viser : le curseur reste, puis boutons de clic · Pavé : comme un trackpad' },
  { t: 'Affichage', a: true, o: [['fit', 'Ajuster'], ['fill', 'Remplir'], ['2', '×2'], ['3', '×3'], ['4', '×4']], d: 'Pincez pour zoomer, deux doigts pour déplacer la vue' },
  { t: 'Qualité', k: 'quality', o: [['auto', 'Auto'], ['fluide', 'Fluide'], ['equilibre', 'Équilibré'], ['net', 'Net']] },
  { t: 'Clavier', k: 'kbd', o: [['jarvis', 'JARVIS'], ['system', 'Téléphone'], ['off', 'Masqué']] },
  { t: 'Clavier en paysage', k: 'kbAuto', o: [[true, 'Masquage auto'], [false, 'Toujours visible']], d: 'Masquage auto : le clavier se range après 5 s sans frappe (touche ⌨ flottante pour le rappeler)' },
  { t: 'Taille des touches', k: 'kbSize', o: [['s', 'Petites'], ['m', 'Moyennes'], ['l', 'Grandes']] },
  { t: 'Vitesse du pavé', k: 'pad', o: [[1.0, 'Lente'], [1.6, 'Normale'], [2.6, 'Rapide']] },
  { t: 'Main', k: 'lefty', o: [[false, 'Droitier'], [true, 'Gaucher']] },
  { t: 'Zoom', k: 'lock', o: [[false, 'Libre'], [true, 'Verrouillé']], d: 'Verrouillé : deux doigts = défilement du PC' },
  { t: 'Orientation', k: 'autoLand', o: [[true, 'Paysage auto'], [false, 'Libre']] },
];

export function createRemote({ send, getAgent }) {
  const $ = (id) => document.getElementById(id);
  const root = $('rc'), top = $('rc-top'), view = $('rc-view'), img = $('rc-screen'), marker = $('rc-marker');
  const kbEl = $('rc-kb'), input = $('rc-input'), quick = $('rc-keys'), sheet = $('rc-sheet');
  const hint = $('rc-hint'), state = $('rc-state'), wait = $('rc-wait'), rail = $('rc-rail'), aim = $('rc-aim');
  const isTouch = () => matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);

  const prefs = loadPrefs();
  if (prefs.kbd == null) prefs.kbd = isTouch() ? 'jarvis' : 'off';
  const save = () => { try { localStorage.setItem('jv-rc', JSON.stringify(prefs)); } catch {} };

  let isOpen = false, agentId = null, lastUrl = null, imgAR = 16 / 9, sentOpts = '';
  const T = { z: 1, tx: 0, ty: 0 }; // zoom (1 = ajusté) et décalage de l'image dans la vue (px)
  const virt = { x: 0.5, y: 0.5 }; // position (0..1) du curseur du PC, telle que nous l'avons envoyée
  const mods = { ctrl: false, alt: false, shift: false, win: false };

  const ev = (e) => send({ type: 'rc_input', ev: e });

  // ------------------------------------------------------------------ géométrie
  const insetBottom = () => (root.classList.contains('rc-land') && !kbEl.hidden && !kbEl.classList.contains('away') ? kbEl.offsetHeight : 0);
  // `inset` = hauteur du clavier superposé (paysage) : l'image reste ajustée à TOUTE la vue, mais quand on zoome
  // on peut déplacer la vue pour amener n'importe quelle zone au-dessus du clavier.
  function metrics() {
    const r = view.getBoundingClientRect();
    const vw = r.width, vh = Math.max(40, r.height);
    let bw = vw, bh = vw / imgAR;
    if (bh > vh) { bh = vh; bw = vh * imgAR; }
    return { r, vw, vh, bw, bh, inset: insetBottom() };
  }
  function apply() {
    const m = metrics();
    const W = m.bw * T.z, H = m.bh * T.z;
    const vhe = m.vh - m.inset;
    T.tx = W <= m.vw ? (m.vw - W) / 2 : clamp(T.tx, m.vw - W, 0);
    if (T.z <= 1.001) T.ty = (m.vh - H) / 2;
    else T.ty = H <= vhe ? (vhe - H) / 2 : clamp(T.ty, vhe - H, 0);
    img.style.width = `${W}px`; img.style.height = `${H}px`;
    img.style.transform = `translate(${T.tx}px, ${T.ty}px)`;
    placeMarker();
  }
  function toNorm(cx, cy) {
    const m = metrics();
    const W = m.bw * T.z, H = m.bh * T.z;
    return [clamp((cx - m.r.left - T.tx) / W, 0, 1), clamp((cy - m.r.top - T.ty) / H, 0, 1)];
  }
  function placeMarker() {
    marker.hidden = !(isOpen && prefs.mode !== 'direct' && img.naturalWidth);
    if (marker.hidden) return;
    const m = metrics();
    marker.style.transform = `translate(${T.tx + virt.x * m.bw * T.z - 16}px, ${T.ty + virt.y * m.bh * T.z - 16}px)`;
  }
  function setZoom(z, ax, ay) {
    z = clamp(z, 1, 8);
    const k = z / T.z;
    T.tx = ax - (ax - T.tx) * k; T.ty = ay - (ay - T.ty) * k; T.z = z;
    apply(); scheduleQuality();
  }
  function fitView(kind) {
    const m = metrics();
    if (kind === 'fit') T.z = 1;
    else if (kind === 'fill') T.z = Math.max(m.vw / m.bw, m.vh / m.bh);
    else T.z = clamp(Number(kind) || 1, 1, 8);
    T.tx = (m.vw - m.bw * T.z) / 2; T.ty = (m.vh - m.bh * T.z) / 2;
    apply(); scheduleQuality();
  }
  /** Garde le curseur visible quand la vue est zoomée (pavé tactile / viser). */
  function followCursor() {
    if (T.z <= 1.02) return;
    const m = metrics();
    const px = T.tx + virt.x * m.bw * T.z, py = T.ty + virt.y * m.bh * T.z, pad = 40, vhe = m.vh - m.inset;
    if (px < pad) T.tx += pad - px; else if (px > m.vw - pad) T.tx -= px - (m.vw - pad);
    if (py < pad) T.ty += pad - py; else if (py > vhe - pad) T.ty -= py - (vhe - pad);
    apply();
  }

  // ------------------------------------------------------------------ qualité adaptative
  const effectiveOpts = () => {
    if (prefs.quality !== 'auto') return PRESETS[prefs.quality] || PRESETS.equilibre;
    if (T.z > 2.6) return { fps: 3, w: 1920, q: 70 };
    if (T.z > 1.5) return PRESETS.net;
    return isTouch() ? PRESETS.fluide : PRESETS.equilibre;
  };
  const startMsg = () => { const o = effectiveOpts(); sentOpts = JSON.stringify(o); send({ type: 'rc_start', agentId, opts: o }); };
  let qTimer = null;
  function scheduleQuality() {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { if (isOpen && JSON.stringify(effectiveOpts()) !== sentOpts) startMsg(); }, 500);
  }

  // ------------------------------------------------------------------ envoi de la souris
  let lastMove = 0, pending = null, moveTimer = null;
  function flush() {
    clearTimeout(moveTimer); moveTimer = null;
    if (!pending) return;
    ev({ k: 'm', x: pending[0], y: pending[1] });
    pending = null; lastMove = performance.now();
  }
  function move(x, y, now = false) {
    virt.x = x; virt.y = y;
    placeMarker();
    pending = [x, y];
    if (now || performance.now() - lastMove >= 28) flush();
    else if (!moveTimer) moveTimer = setTimeout(flush, 28);
  }
  const click = (b = 'l', n = 1) => { flush(); for (let i = 0; i < n; i++) { ev({ k: 'd', b }); ev({ k: 'u', b }); } };
  function ripple(cx, cy) {
    const r = view.getBoundingClientRect();
    const d = document.createElement('i');
    d.className = 'rc-ripple';
    d.style.left = `${cx - r.left}px`; d.style.top = `${cy - r.top}px`;
    view.append(d);
    setTimeout(() => d.remove(), 450);
  }

  // ------------------------------------------------------------------ gestes
  const ptrs = new Map();
  let one = null, two = null, ignoreOne = false, mouseBtn = null, aimHold = false, edgeTimer = null, lastPt = null;

  const cancelOne = (release) => {
    if (!one) return;
    clearTimeout(one.lp); clearTimeout(one.pre);
    if (release && one.down) ev({ k: 'u', b: 'l' });
    one = null;
    stopEdge();
  };
  function stopEdge() { clearInterval(edgeTimer); edgeTimer = null; }

  /** Défilement automatique de la vue quand on glisse le doigt près du bord d'une vue zoomée. */
  function edgePan(cx, cy) {
    lastPt = [cx, cy];
    if (T.z <= 1.05 || edgeTimer) return;
    edgeTimer = setInterval(() => {
      if (!one || !lastPt) return stopEdge();
      const m = metrics();
      const lx = lastPt[0] - m.r.left, ly = lastPt[1] - m.r.top;
      const vx = lx < EDGE ? (EDGE - lx) / EDGE * 14 : lx > m.vw - EDGE ? -(lx - (m.vw - EDGE)) / EDGE * 14 : 0;
      const vhe = m.vh - m.inset;
      const vy = ly < EDGE ? (EDGE - ly) / EDGE * 14 : ly > vhe - EDGE ? -(ly - (vhe - EDGE)) / EDGE * 14 : 0;
      if (!vx && !vy) return;
      T.tx += vx; T.ty += vy; apply();
      const [nx, ny] = toNorm(lastPt[0], lastPt[1] - (prefs.mode === 'aim' ? AIM_OFFSET : 0));
      move(nx, ny);
    }, 16);
  }

  function startOne(e) {
    one = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), tl: performance.now(), moved: false, down: false, long: false };
    if (prefs.mode === 'direct') {
      // Le curseur du PC suit le doigt après un court délai : si un 2e doigt arrive (zoom, défilement), il ne saute pas.
      one.pre = setTimeout(() => { if (one && !one.moved) { const [x, y] = toNorm(one.sx, one.sy); move(x, y, true); } }, 70);
      one.lp = setTimeout(() => {
        if (one && !one.moved) { const [x, y] = toNorm(one.sx, one.sy); move(x, y, true); one.long = true; click('r'); navigator.vibrate?.(25); }
      }, 550);
    } else if (prefs.mode === 'aim') {
      const [x, y] = toNorm(e.clientX, e.clientY - AIM_OFFSET);
      move(x, y, true);
    } else { // pavé tactile : appui long = cliquer-déposer
      one.lp = setTimeout(() => { if (one && !one.moved) { one.long = true; one.down = true; ev({ k: 'd', b: 'l' }); navigator.vibrate?.(25); } }, 450);
    }
  }

  function moveOne(e) {
    if (!one || one.id !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - one.sx, e.clientY - one.sy);
    if (!one.moved && dist > 8) {
      one.moved = true;
      clearTimeout(one.lp); clearTimeout(one.pre);
      if (prefs.mode === 'direct' && !one.long) { // glisser = cliquer-déposer, depuis le point de départ
        const [sx, sy] = toNorm(one.sx, one.sy);
        move(sx, sy, true); ev({ k: 'd', b: 'l' }); one.down = true;
      }
    }
    if (prefs.mode === 'direct') {
      if (one.moved) { const [x, y] = toNorm(e.clientX, e.clientY); move(x, y); edgePan(e.clientX, e.clientY); }
    } else if (prefs.mode === 'aim') {
      const [x, y] = toNorm(e.clientX, e.clientY - AIM_OFFSET);
      move(x, y); edgePan(e.clientX, e.clientY);
    } else if (one.moved || one.long) {
      const m = metrics();
      const now = performance.now();
      const dx = e.clientX - one.lx, dy = e.clientY - one.ly;
      const speed = Math.hypot(dx, dy) / Math.max(1, now - one.tl);
      const gain = prefs.pad * (1 + Math.min(1.5, speed * 0.8));
      move(clamp(virt.x + (dx * gain) / (m.bw * T.z), 0, 1), clamp(virt.y + (dy * gain) / (m.bh * T.z), 0, 1));
      followCursor();
    }
    one.lx = e.clientX; one.ly = e.clientY; one.tl = performance.now();
  }

  function endOne(e) {
    if (!one || one.id !== e.pointerId) return;
    clearTimeout(one.lp); clearTimeout(one.pre); stopEdge();
    if (prefs.mode === 'direct') {
      const [x, y] = toNorm(e.clientX, e.clientY);
      move(x, y, true);
      if (!one.long) { if (one.down) ev({ k: 'u', b: 'l' }); else { click('l'); ripple(e.clientX, e.clientY); } }
    } else if (prefs.mode === 'pad') {
      if (one.down) ev({ k: 'u', b: 'l' });
      else if (!one.moved && performance.now() - one.t0 < 280) { click('l'); ripple(...padPoint()); }
    }
    one = null;
  }
  const padPoint = () => { const m = metrics(); return [m.r.left + T.tx + virt.x * m.bw * T.z, m.r.top + T.ty + virt.y * m.bh * T.z]; };

  function startTwo() {
    cancelOne(true);
    const [a, b] = [...ptrs.values()];
    const m = metrics();
    two = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx0: (a.x + b.x) / 2 - m.r.left, my0: (a.y + b.y) / 2 - m.r.top,
      z0: T.z, tx0: T.tx, ty0: T.ty, mode: null, acc: 0, py: (a.y + b.y) / 2, t0: performance.now(),
    };
  }
  function moveTwo() {
    if (!two || ptrs.size < 2) return;
    const [a, b] = [...ptrs.values()];
    const m = metrics();
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2 - m.r.left, my = (a.y + b.y) / 2 - m.r.top;
    if (!two.mode) {
      const dz = Math.abs(d / two.d0 - 1), dm = Math.hypot(mx - two.mx0, my - two.my0);
      if (dz > 0.07 && !prefs.lock) two.mode = 'zoom';
      else if (dm > 12) two.mode = T.z > 1.02 && !prefs.lock ? 'pan' : 'scroll';
    }
    if (two.mode === 'zoom') {
      const z = clamp(two.z0 * (d / two.d0), 1, 8), k = z / two.z0;
      T.z = z; T.tx = mx - (two.mx0 - two.tx0) * k; T.ty = my - (two.my0 - two.ty0) * k;
      apply(); scheduleQuality();
    } else if (two.mode === 'pan') {
      T.tx = two.tx0 + (mx - two.mx0); T.ty = two.ty0 + (my - two.my0); apply();
    } else if (two.mode === 'scroll') {
      two.acc += (my + m.r.top) - two.py;
      const steps = Math.trunc(two.acc / 22);
      if (steps) { ev({ k: 's', n: steps }); two.acc -= steps * 22; }
    }
    two.py = my + m.r.top;
  }
  function endTwo() {
    if (!two) return;
    if (!two.mode && performance.now() - two.t0 < 300) { // toucher à deux doigts = clic droit
      const [a, b] = [...ptrs.values()];
      if (prefs.mode === 'pad') click('r');
      else if (a && b) { const [x, y] = toNorm((a.x + b.x) / 2, (a.y + b.y) / 2); move(x, y, true); click('r'); }
      navigator.vibrate?.(20);
    }
    two = null;
    ignoreOne = true;
  }

  view.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    closeSheet();
    try { view.setPointerCapture(e.pointerId); } catch {}
    if (e.pointerType === 'mouse') {
      const [x, y] = toNorm(e.clientX, e.clientY);
      move(x, y, true);
      if (e.button === 0 || e.button === 2) { mouseBtn = e.button === 2 ? 'r' : 'l'; ev({ k: 'd', b: mouseBtn }); }
      focusKbd();
      return;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1 && !ignoreOne) startOne(e);
    else if (ptrs.size === 2) startTwo();
  });
  view.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') { const [x, y] = toNorm(e.clientX, e.clientY); move(x, y); return; }
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size >= 2) moveTwo();
    else if (!ignoreOne) moveOne(e);
  });
  function pointerEnd(e) {
    if (e.pointerType === 'mouse') {
      flush();
      if (mouseBtn) { ev({ k: 'u', b: mouseBtn }); mouseBtn = null; }
      focusKbd();
      return;
    }
    if (ptrs.size >= 2) endTwo(); else endOne(e);
    ptrs.delete(e.pointerId);
    if (!ptrs.size) { ignoreOne = false; one = null; two = null; stopEdge(); }
    focusKbd();
  }
  view.addEventListener('pointerup', pointerEnd);
  view.addEventListener('pointercancel', pointerEnd);
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) { const r = view.getBoundingClientRect(); setZoom(T.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top); return; }
    ev({ k: 's', n: -Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 100)) });
  }, { passive: false });

  // Boutons de zoom
  const center = () => { const m = metrics(); return [m.vw / 2, m.vh / 2]; };
  $('rc-zin').onclick = () => setZoom(T.z * 1.5, ...center());
  $('rc-zout').onclick = () => setZoom(T.z / 1.5, ...center());
  $('rc-zfit').onclick = () => fitView(T.z > 1.02 ? 'fit' : 'fill');

  // Ascenseur : défilement du PC (indépendant du zoom)
  const scrollBy = (n) => ev({ k: 's', n });
  $('rc-up').onclick = () => scrollBy(3);
  $('rc-down').onclick = () => scrollBy(-3);
  {
    const drag = $('rc-rail-drag');
    let y0 = null, acc = 0;
    drag.addEventListener('pointerdown', (e) => { e.preventDefault(); try { drag.setPointerCapture(e.pointerId); } catch {} y0 = e.clientY; acc = 0; drag.classList.add('on'); });
    drag.addEventListener('pointermove', (e) => {
      if (y0 == null) return;
      acc += e.clientY - y0; y0 = e.clientY;
      const steps = Math.trunc(acc / 14);
      if (steps) { scrollBy(-steps); acc -= steps * 14; navigator.vibrate?.(3); }
    });
    const end = () => { y0 = null; drag.classList.remove('on'); };
    drag.addEventListener('pointerup', end); drag.addEventListener('pointercancel', end);
  }

  // Boutons du mode « Viser »
  aim.addEventListener('pointerdown', (e) => e.preventDefault());
  aim.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    navigator.vibrate?.(12);
    if (a === 'click') click('l'); else if (a === 'dbl') click('l', 2); else if (a === 'right') click('r');
    else if (a === 'drag') {
      aimHold = !aimHold;
      flush(); ev({ k: aimHold ? 'd' : 'u', b: 'l' });
      e.target.closest('button').classList.toggle('on', aimHold);
    }
  });

  // ------------------------------------------------------------------ clavier
  const anyMod = () => mods.ctrl || mods.alt || mods.shift || mods.win;
  const getMods = () => mods;
  function clearMods() { for (const k of Object.keys(mods)) mods[k] = false; paintMods(); }
  function toggleMod(m) { mods[m] = !mods[m]; paintMods(); armAway(); }
  function paintMods() {
    quick.querySelectorAll('[data-mod]').forEach((b) => b.classList.toggle('on', !!mods[b.dataset.mod]));
    keyboard?.refreshMods();
  }
  // Clavier superposé (paysage) : se range tout seul après quelques secondes sans frappe
  const fab = $('rc-kbfab');
  let awayTimer = null;
  const kbOverlay = () => root.classList.contains('rc-land') && prefs.kbd === 'jarvis';
  function setAway(a) {
    const on = a && kbOverlay();
    kbEl.classList.toggle('away', on);
    fab.hidden = !on;
    if (!on) armAway();
    apply();
  }
  function armAway() {
    clearTimeout(awayTimer);
    if (kbOverlay() && prefs.kbAuto && !kbEl.classList.contains('away')) awayTimer = setTimeout(() => setAway(true), 5000);
  }
  fab.addEventListener('pointerdown', (e) => e.preventDefault());
  fab.onclick = () => setAway(false);

  function sendKey(combo) {
    armAway();
    const parts = [];
    if (mods.ctrl) parts.push('ctrl'); if (mods.alt) parts.push('alt'); if (mods.shift) parts.push('shift'); if (mods.win) parts.push('win');
    parts.push(combo);
    ev({ k: 'p', keys: parts.join('+') });
    clearMods();
  }
  function typeText(t) {
    if (!t) return;
    armAway();
    if (anyMod() && t.length === 1) return sendKey(t.toLowerCase());
    ev({ k: 't', text: t });
  }

  const keyboard = createKeyboard({ el: kbEl, onType: typeText, onKey: sendKey, getMods, toggleMod, onHide: () => setKbd('off') });

  const resetInput = () => { input.value = SENT; try { input.setSelectionRange(SENT.length, SENT.length); } catch {} };
  function focusKbd() {
    if (!isOpen) return;
    if (prefs.kbd === 'jarvis' && isTouch()) return; // clavier JARVIS : on ne veut surtout pas ouvrir celui du téléphone
    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  }
  let lastEnter = 0;
  const enter = () => { const n = performance.now(); if (n - lastEnter > 80) { lastEnter = n; sendKey('enter'); } };

  input.addEventListener('beforeinput', (e) => {
    const t = e.inputType || '';
    if (e.isComposing || t.startsWith('insertComposition')) return;
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
  let comp = '';
  input.addEventListener('compositionupdate', (e) => {
    const d = e.data || '';
    let i = 0;
    while (i < comp.length && i < d.length && comp[i] === d[i]) i++;
    for (let k = comp.length - i; k > 0; k--) ev({ k: 'p', keys: 'backspace' });
    if (d.slice(i)) ev({ k: 't', text: d.slice(i) });
    comp = d;
  });
  input.addEventListener('compositionend', () => { comp = ''; resetInput(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const k = e.key, mod = e.ctrlKey || e.altKey || e.metaKey, parts = [];
    if (e.ctrlKey) parts.push('ctrl'); if (e.altKey) parts.push('alt'); if (e.metaKey) parts.push('win');
    if (k === 'Enter') { e.preventDefault(); if (mod) sendKey([...parts, 'enter'].join('+')); else enter(); return; }
    const name = NAMED[k] || (/^F\d{1,2}$/.test(k) ? k.toLowerCase() : null);
    if (name) { if (e.shiftKey) parts.push('shift'); sendKey([...parts, name].join('+')); e.preventDefault(); }
    else if (mod && k.length === 1) { if (e.shiftKey) parts.push('shift'); sendKey([...parts, k.toLowerCase()].join('+')); e.preventDefault(); }
  });
  input.addEventListener('blur', () => { if (isOpen && isTouch() && prefs.kbd === 'system') hint.textContent = "⌨ Clavier masqué — touchez l'écran pour le rouvrir", hint.hidden = false; });
  input.addEventListener('focus', () => { if (prefs.kbd === 'system') hint.hidden = true; });

  for (const [label, key] of QUICK) { // barre rapide (clavier du téléphone)
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = 'rc-key';
    if (key.startsWith('mod:')) b.dataset.mod = key.slice(4);
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => { if (b.dataset.mod) toggleMod(b.dataset.mod); else sendKey(key); focusKbd(); });
    quick.append(b);
  }

  function setKbd(mode) {
    prefs.kbd = mode; save();
    kbEl.hidden = mode !== 'jarvis';
    quick.hidden = mode !== 'system';
    input.setAttribute('inputmode', mode === 'system' ? 'text' : 'none');
    input.blur();
    if (isOpen) setTimeout(() => { resetInput(); focusKbd(); relayout(); }, 30);
    paintSheet(); relayout();
  }

  // ------------------------------------------------------------------ réglages
  function paintSheet() {
    sheet.querySelectorAll('.chip[data-k]').forEach((c) => c.setAttribute('aria-pressed', String(String(prefs[c.dataset.k]) === c.dataset.v)));
  }
  (function buildSheet() {
    const head = document.createElement('div');
    head.className = 'sheet-head';
    head.innerHTML = '<strong class="caps">Réglages de l\'écran</strong><button type="button" class="rc-ib" id="rc-sheet-x" aria-label="Fermer">✕</button>';
    sheet.append(head);
    for (const g of SHEET) {
      const box = document.createElement('div'); box.className = 'sheet-group';
      const h = document.createElement('div'); h.className = 'sheet-title'; h.textContent = g.t; box.append(h);
      const row = document.createElement('div'); row.className = 'chips';
      for (const [v, label] of g.o) {
        const c = document.createElement('button');
        c.type = 'button'; c.className = 'chip'; c.textContent = label;
        if (g.k) { c.dataset.k = g.k; c.dataset.v = String(v); } else c.dataset.fit = String(v);
        c.addEventListener('click', () => {
          if (g.a) { fitView(v); closeSheet(); return; }
          prefs[g.k] = v; save(); applyPrefs(g.k);
        });
        row.append(c);
      }
      box.append(row);
      if (g.d) { const d = document.createElement('div'); d.className = 'sheet-desc'; d.textContent = g.d; box.append(d); }
      sheet.append(box);
    }
    $('rc-sheet-x').onclick = closeSheet;
  })();
  const openSheet = () => { paintSheet(); sheet.hidden = false; };
  function closeSheet() { sheet.hidden = true; }

  function applyPrefs(changed) {
    root.classList.toggle('rc-lefty', !!prefs.lefty);
    root.style.setProperty('--kh', { s: '38px', m: '46px', l: '56px' }[prefs.kbSize] || '46px');
    aim.hidden = prefs.mode !== 'aim';
    if (changed === 'kbd') setKbd(prefs.kbd);
    if (changed === 'quality') scheduleQuality();
    if (changed === 'autoLand' && prefs.autoLand && isOpen) goImmersive();
    if (changed === 'mode' && aimHold) { aimHold = false; ev({ k: 'u', b: 'l' }); aim.querySelector('[data-a=drag]')?.classList.remove('on'); }
    paintSheet(); relayout();
  }

  // ------------------------------------------------------------------ plein écran / paysage
  async function goImmersive() {
    try { if (!document.fullscreenElement) await root.requestFullscreen({ navigationUI: 'hide' }); } catch {}
    try { await screen.orientation?.lock?.('landscape'); } catch {}
    relayout();
  }
  function leaveImmersive() {
    try { screen.orientation?.unlock?.(); } catch {}
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch {}
  }
  $('rc-fs').onclick = () => { if (document.fullscreenElement) { leaveImmersive(); } else goImmersive(); };

  function relayout() {
    const land = innerWidth > innerHeight && innerHeight < 620;
    root.classList.toggle('rc-land', land);
    if (!land) { kbEl.classList.remove('away'); fab.hidden = true; clearTimeout(awayTimer); } else if (!kbEl.classList.contains('away')) armAway();
    root.classList.toggle('rc-touch', isTouch());
    const vv = window.visualViewport;
    root.style.setProperty('--vvh', `${vv ? vv.height : innerHeight}px`);
    root.style.setProperty('--vvt', `${vv ? vv.offsetTop : 0}px`);
    root.style.setProperty('--vvw', `${vv ? vv.width : innerWidth}px`);
    root.style.setProperty('--vvl', `${vv ? vv.offsetLeft : 0}px`);
    requestAnimationFrame(apply);
  }
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', () => setTimeout(relayout, 250));
  window.visualViewport?.addEventListener('resize', relayout);
  window.visualViewport?.addEventListener('scroll', relayout);
  document.addEventListener('fullscreenchange', () => setTimeout(relayout, 150));
  if (window.ResizeObserver) new ResizeObserver(() => isOpen && apply()).observe(view);

  // barre du haut
  $('rc-opts').onclick = () => (sheet.hidden ? openSheet() : closeSheet());
  $('rc-kbd-btn').onclick = () => setKbd({ jarvis: 'system', system: 'off', off: 'jarvis' }[prefs.kbd] || 'jarvis');
  $('rc-kbd-btn').addEventListener('pointerdown', (e) => e.preventDefault());
  $('rc-close').onclick = () => api.close();
  $('rc-fold').onclick = () => { root.classList.add('rc-folded'); relayout(); };
  $('rc-unfold').onclick = () => { root.classList.remove('rc-folded'); relayout(); };

  img.addEventListener('load', () => {
    if (img.naturalWidth && img.naturalHeight) {
      const ar = img.naturalWidth / img.naturalHeight;
      if (Math.abs(ar - imgAR) > 0.001) { imgAR = ar; apply(); } else placeMarker();
    }
  });

  // ------------------------------------------------------------------ cycle de vie
  const api = {
    /** À appeler directement depuis un clic (geste utilisateur) : requis pour le plein écran et le clavier du téléphone. */
    open() {
      const agent = getAgent();
      if (!agent) return false;
      agentId = agent.id; isOpen = true;
      root.hidden = false; document.body.classList.add('rc-open');
      state.textContent = `${agent.name} — connexion…`;
      wait.textContent = "Connexion à l'écran du PC…"; wait.hidden = false;
      hint.hidden = true;
      T.z = 1;
      applyPrefs();
      setKbd(prefs.kbd);
      resetInput(); focusKbd();
      if (isTouch() && prefs.autoLand) goImmersive();
      if (isTouch() && innerHeight > innerWidth) {
        hint.textContent = '↻ Paysage + ⛶ pour agrandir · pincez pour zoomer · deux doigts pour déplacer la vue';
        hint.hidden = false;
        setTimeout(() => { if (prefs.kbd !== 'system' || document.activeElement === input) hint.hidden = true; }, 6000);
      }
      relayout(); startMsg();
      return true;
    },
    close() {
      if (!isOpen) return;
      send({ type: 'rc_stop' });
      if (aimHold) { ev({ k: 'u', b: 'l' }); aimHold = false; }
      isOpen = false; root.hidden = true; document.body.classList.remove('rc-open');
      root.classList.remove('rc-folded');
      clearMods(); input.blur(); closeSheet(); leaveImmersive();
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
    /** Pour les tests : état interne du zoom / de la souris virtuelle. */
    _debug() { return { T: { ...T }, virt: { ...virt }, prefs: { ...prefs }, mods: { ...mods }, ptrs: ptrs.size, ignoreOne, one: one ? { ...one, lp: undefined } : null, two: !!two }; },
  };
  applyPrefs();
  return api;
}
