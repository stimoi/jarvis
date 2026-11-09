// Réacteur Arc façon JARVIS (SVG). Les couleurs suivent la variable CSS --c (états : veille, écoute, réflexion, parole).
export function reactorHTML() {
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const long = i % 6 === 0;
    return `<line x1="200" y1="${long ? 8 : 12}" x2="200" y2="${long ? 24 : 20}" transform="rotate(${i * 5} 200 200)"/>`;
  }).join('');
  const bars = Array.from({ length: 3 }, (_, i) => `<rect x="193" y="150" width="14" height="30" transform="rotate(${i * 120} 200 200)" rx="2"/>`).join('');
  const dots = Array.from({ length: 24 }, (_, i) => `<circle cx="200" cy="52" r="2.2" transform="rotate(${i * 15} 200 200)"/>`).join('');
  return `<div class="halo"></div>
<svg viewBox="0 0 400 400" class="reactor-svg" aria-hidden="true">
  <defs>
    <radialGradient id="rg-core"><stop offset="0" style="stop-color:#fff"/><stop offset=".4" style="stop-color:var(--c)"/><stop offset="1" style="stop-color:var(--c);stop-opacity:0"/></radialGradient>
    <filter id="rg-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <g class="g-ticks" filter="url(#rg-glow)" stroke="var(--c)" stroke-width="1.6" opacity=".85">${ticks}</g>
  <circle class="g-outer" cx="200" cy="200" r="178" fill="none" stroke="var(--c)" stroke-width="1.4" stroke-dasharray="2 10" opacity=".7"/>
  <circle cx="200" cy="200" r="166" fill="none" stroke="var(--c)" stroke-width="1" opacity=".35"/>
  <g class="g-inner" fill="var(--c)" opacity=".8">${dots}</g>
  <circle class="g-seg" cx="200" cy="200" r="134" fill="none" stroke="var(--c)" stroke-width="22" stroke-dasharray="58 13.2" filter="url(#rg-glow)" opacity=".9"/>
  <circle cx="200" cy="200" r="114" fill="none" stroke="var(--c)" stroke-width="2" opacity=".9" filter="url(#rg-glow)"/>
  <circle cx="200" cy="200" r="104" fill="rgba(2,12,26,.85)" stroke="var(--c)" stroke-width=".8" opacity=".95"/>
  <g class="g-tri" fill="var(--c)" opacity=".55" filter="url(#rg-glow)">${bars}</g>
  <polygon class="g-tri" points="200,268 141,166 259,166" fill="none" stroke="var(--c)" stroke-width="11" stroke-linejoin="round" filter="url(#rg-glow)"/>
  <polygon points="200,246 160,177 240,177" fill="none" stroke="var(--c)" stroke-width="1.4" opacity=".6"/>
  <g class="g-core"><circle cx="200" cy="200" r="34" fill="url(#rg-core)" filter="url(#rg-glow)"/><circle cx="200" cy="200" r="9" fill="#fff" opacity=".95"/></g>
</svg>`;
}

export function mountReactor(el) {
  el.innerHTML = reactorHTML();
}
