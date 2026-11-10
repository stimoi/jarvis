// Contrôle à distance : réglages de diffusion de l'écran, bornés côté serveur (le client ne décide pas des limites).
const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

/** fps : images/s (1-10) · w : largeur max en px (320-1920) · q : qualité JPEG (20-85) */
export const rcOpts = (o = {}) => ({ fps: num(o?.fps, 1, 10, 5), w: num(o?.w, 320, 1920, 1000), q: num(o?.q, 20, 85, 55) });
