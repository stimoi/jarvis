// Clavier JARVIS : clavier AZERTY conçu pour piloter un PC depuis un téléphone
// (modificateurs collants, F1-F12, flèches, raccourcis, accents en appui long, répétition des touches).
const ALTS = {
  a: ['à', 'â', 'ä', 'æ'], e: ['é', 'è', 'ê', 'ë', '€'], u: ['ù', 'û', 'ü'], i: ['î', 'ï'], o: ['ô', 'ö', 'œ'],
  c: ['ç'], y: ['ÿ'], n: ['ñ'], s: ['ß'], '.': [',', ';', ':', '!', '?', '…'], ',': ['.', ';'], '-': ['_', '–', '—'],
  "'": ['"', '`'], '?': ['¿', '!'], '€': ['$', '£', '¥'], é: ['e', 'è', 'ê', 'ë'], è: ['é', 'ê', 'ë'], à: ['â', 'ä'],
};
const ch = (c, extra = {}) => ({ ch: c, ...extra });
const row = (s) => [...s].map((c) => ch(c));
const MOD = (m, label, w = 1.2) => ({ mod: m, label, w, cls: 'fn' });
const KEY = (k, label, w = 1, extra = {}) => ({ key: k, label, w, cls: 'fn', ...extra });

const NAV = [
  KEY('esc', 'Échap', 1.3), KEY('tab', 'Tab', 1), MOD('win', 'Win', 1), { layer: 'fn', toggle: true, label: 'Fn', w: 1, cls: 'fn' },
  KEY('left', '←', 1, { rep: true }), KEY('up', '↑', 1, { rep: true }), KEY('down', '↓', 1, { rep: true }), KEY('right', '→', 1, { rep: true }),
  KEY('delete', 'Suppr', 1.3, { rep: true }), { act: 'hide', label: '▾', w: 0.9, cls: 'fn' },
];

const LAYERS = {
  abc: [
    row('azertyuiop'),
    row('qsdfghjklm'),
    [{ shift: true, label: '⇧', w: 1.5, cls: 'fn' }, ...row('wxcvbn'), KEY('backspace', '⌫', 1.5, { rep: true })],
    [{ layer: 'sym', label: '123', w: 1.5, cls: 'fn' }, MOD('ctrl', 'Ctrl'), MOD('alt', 'Alt'), ch(' ', { label: 'espace', w: 4 }), ch(','), ch('.'), KEY('enter', '⏎', 1.7, { cls: 'act' })],
  ],
  sym: [
    row('1234567890'),
    row('@#€&_-+=/\\'),
    row('()[]{}<>|~'),
    row('%*$^!?:;"\''),
    [{ layer: 'abc', label: 'ABC', w: 1.5, cls: 'fn' }, ...row('éèàùçêô'), KEY('backspace', '⌫', 1.5, { rep: true })],
    [MOD('ctrl', 'Ctrl', 1.4), MOD('alt', 'Alt', 1.4), ch(' ', { label: 'espace', w: 4.4 }), ch(','), ch('.'), KEY('enter', '⏎', 1.8, { cls: 'act' })],
  ],
  fn: [
    ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((k) => KEY(k, k.toUpperCase())),
    ['f7', 'f8', 'f9', 'f10', 'f11', 'f12'].map((k) => KEY(k, k.toUpperCase())),
    [KEY('printscreen', 'Impr'), KEY('insert', 'Ins'), KEY('home', 'Début'), KEY('end', 'Fin'), KEY('pageup', 'PgHaut'), KEY('pagedown', 'PgBas')],
    [['ctrl+c', 'Copier'], ['ctrl+v', 'Coller'], ['ctrl+x', 'Couper'], ['ctrl+a', 'Tout'], ['ctrl+z', 'Annuler'], ['ctrl+s', 'Enreg.']].map(([k, l]) => KEY(k, l, 1.2, { cls: 'sc' })),
    [['alt+tab', 'Alt+Tab'], ['win+d', 'Win+D'], ['win+e', 'Win+E'], ['ctrl+shift+esc', 'Gestionnaire'], ['ctrl+f', 'Chercher'], ['f11', 'Plein écran']].map(([k, l]) => KEY(k, l, 1.2, { cls: 'sc' })),
    [{ layer: 'abc', label: 'ABC', w: 1.5, cls: 'fn' }, MOD('ctrl', 'Ctrl'), MOD('alt', 'Alt'), MOD('win', 'Win'), KEY('enter', '⏎', 1.7, { cls: 'act' })],
  ],
};

/**
 * @param {{el: HTMLElement, onType:(t:string)=>void, onKey:(combo:string)=>void, getMods:()=>object, toggleMod:(m:string)=>void, onHide:()=>void}} o
 */
export function createKeyboard({ el, onType, onKey, getMods, toggleMod, onHide }) {
  let layer = 'abc';
  let shift = 'off'; // off | once | caps
  let lastShiftTap = 0;
  let cur = null; // touche enfoncée {def, node, timer, rep, popup}

  const buzz = () => navigator.vibrate?.(7);

  function keyNode(def) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `kb-key ${def.cls || ''}`;
    b.style.flex = String(def.w || 1);
    b.dataset.i = '';
    b.tabIndex = -1;
    b.textContent = def.label ?? def.ch;
    if (def.ch && def.ch.length === 1 && /\p{L}/u.test(def.ch) && def.ch !== ' ') b.dataset.letter = def.ch;
    b._def = def;
    if (def.shift) b.classList.add('shift');
    return b;
  }

  function render() {
    el.innerHTML = '';
    const nav = document.createElement('div');
    nav.className = 'kb-row nav';
    NAV.forEach((d) => nav.append(keyNode(d)));
    el.append(nav);
    for (const r of LAYERS[layer]) {
      const div = document.createElement('div');
      div.className = 'kb-row';
      r.forEach((d) => div.append(keyNode(d)));
      el.append(div);
    }
    refresh();
  }

  function refresh() {
    const mods = getMods();
    el.querySelectorAll('.kb-key').forEach((b) => {
      const d = b._def;
      if (d.mod) b.classList.toggle('on', !!mods[d.mod]);
      if (d.shift) { b.classList.toggle('on', shift !== 'off'); b.classList.toggle('caps', shift === 'caps'); b.textContent = shift === 'caps' ? '⇪' : '⇧'; }
      if (d.layer && d.toggle) b.classList.toggle('on', layer === d.layer);
      if (b.dataset.letter) b.textContent = shift !== 'off' ? b.dataset.letter.toUpperCase() : b.dataset.letter;
    });
  }

  function typeChar(c) {
    const letter = /\p{L}/u.test(c);
    const up = shift !== 'off' && letter;
    const m = getMods();
    if (m.ctrl || m.alt || m.win) onKey(`${up ? 'shift+' : ''}${c.toLowerCase()}`); // raccourcis : Ctrl+C, Alt+F…
    else onType(up ? c.toUpperCase() : c);
    if (shift === 'once') { shift = 'off'; refresh(); }
  }

  function fire(def) {
    buzz();
    if (def.key) onKey(def.key);
    else if (def.mod) { toggleMod(def.mod); refresh(); }
    else if (def.shift) {
      const now = performance.now();
      shift = shift === 'caps' ? 'off' : now - lastShiftTap < 350 ? 'caps' : shift === 'once' ? 'off' : 'once';
      lastShiftTap = now;
      refresh();
    } else if (def.layer) {
      layer = def.toggle && layer === def.layer ? 'abc' : def.layer;
      render();
    } else if (def.act === 'hide') onHide?.();
  }

  const clearCur = () => {
    if (!cur) return;
    clearTimeout(cur.timer); clearInterval(cur.rep);
    cur.node.classList.remove('down');
    cur.popup?.remove();
    cur = null;
  };

  function showAlts(node, base) {
    const alts = ALTS[base.toLowerCase()];
    if (!alts) return null;
    const pop = document.createElement('div');
    pop.className = 'kb-alts';
    const up = shift !== 'off';
    alts.forEach((a) => { const s = document.createElement('div'); s.className = 'alt'; s.textContent = up ? a.toUpperCase() : a; s.dataset.v = up ? a.toUpperCase() : a; pop.append(s); });
    el.append(pop);
    const r = node.getBoundingClientRect(), pr = el.getBoundingClientRect();
    pop.style.left = `${Math.max(2, Math.min(pr.width - pop.offsetWidth - 2, r.left - pr.left + r.width / 2 - pop.offsetWidth / 2))}px`;
    pop.style.top = `${r.top - pr.top - pop.offsetHeight - 6}px`;
    buzz();
    return pop;
  }

  el.addEventListener('pointerdown', (e) => {
    const node = e.target.closest?.('.kb-key');
    if (!node) return;
    e.preventDefault(); // ne vole jamais le focus (champ de saisie caché) et évite le menu contextuel
    clearCur();
    const def = node._def;
    cur = { def, node };
    node.classList.add('down');
    try { el.setPointerCapture(e.pointerId); } catch {}
    if (def.ch) {
      const c = def.ch;
      if (ALTS[c.toLowerCase()]) cur.timer = setTimeout(() => { if (cur) cur.popup = showAlts(node, c); }, 340);
    } else {
      fire(def);
      if (def.rep) cur.timer = setTimeout(() => { cur.rep = setInterval(() => fire(def), 55); }, 380);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!cur?.popup) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    cur.popup.querySelectorAll('.alt').forEach((a) => a.classList.toggle('sel', a === t));
  });

  function up(e) {
    if (!cur) return;
    const { def, popup } = cur;
    if (def.ch) {
      if (popup) {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        if (t?.classList?.contains('alt')) { buzz(); onType(t.dataset.v); if (shift === 'once') { shift = 'off'; refresh(); } }
      } else { buzz(); typeChar(def.ch); }
    }
    clearCur();
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', clearCur);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  render();
  return { refreshMods: refresh, render };
}
