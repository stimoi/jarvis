// Contrôle à distance : réglages de diffusion de l'écran, bornés côté serveur (le client ne décide pas des limites).
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

/** fps : images/s (1-10) · w : largeur max en px (320-1920) · q : qualité JPEG (20-85) */
export const rcOpts = (o = {}) => ({ fps: num(o?.fps, 1, 10, 5), w: num(o?.w, 320, 1920, 1000), q: num(o?.q, 20, 85, 55) });

/** Statut de mise à jour de l'appli de bureau, tel que relayé par l'agent : on ne garde que des champs bornés. */
export const cleanAppState = (s = {}) => ({
  phase: String(s.phase || '').slice(0, 20),
  current: String(s.current || '').slice(0, 20),
  latest: s.latest ? String(s.latest).slice(0, 20) : null,
  percent: Math.max(0, Math.min(100, Number(s.percent) || 0)),
  notes: String(s.notes || '').slice(0, 300),
  error: String(s.error || '').slice(0, 200),
});