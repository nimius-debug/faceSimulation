// Skin/ingredient model — ported 1:1 from the Claude Design source
// (onset curves, purge spikes, mismatch irritation, status copy).

export const SKIN_META = {
  oily:        { label: 'Oily',    blurb: 'Overactive sebum, visible shine and enlarged pores across the T-zone — prone to breakouts and blackheads.' },
  dry:         { label: 'Dry',     blurb: 'Produces little sebum, so skin looks dull and feels tight, with a weaker barrier and finer texture.' },
  combination: { label: 'Combo',   blurb: 'An oily T-zone with drier cheeks — two skin types on one face, each wanting different care.' },
  sensitive:   { label: 'Sensitive', blurb: 'Reactive and easily flushed, with a compromised barrier that stings at harsh actives.' },
  normal:      { label: 'Normal',  blurb: 'Balanced oil and moisture, small pores and few blemishes — resilient and even.' },
};

export const COND_META = { acne: 'Acne', scars: 'Acne scars', pigment: 'Dark spots', redness: 'Redness', lines: 'Fine lines' };

export const ING = {
  salicylic:   { label: 'Salicylic acid (BHA)', color: '#a9cbb6', short: 'Oil-soluble exfoliant · clears pores',
    blurb: 'A BHA that dissolves oil inside pores. Clears acne and refines texture within weeks — but can dry fragile skin.',
    tau: 0.8, harsh: 0.45, eff: { acne: -0.85, pore: -0.35, sebum: -0.30, pigment: -0.20 } },
  benzoyl:     { label: 'Benzoyl peroxide', color: '#e6dcc4', short: 'Antibacterial · potent acne fighter',
    blurb: 'A potent acne fighter that cuts sebum and bacteria fast. Effective, but drying — keep it away from sensitive skin.',
    tau: 0.7, harsh: 0.72, eff: { acne: -0.95, sebum: -0.35, pore: -0.20 } },
  retinol:     { label: 'Retinol', color: '#eecb9e', short: 'Vitamin A · texture & fine lines',
    blurb: 'Vitamin A. Rebuilds texture, softens lines and fades marks over months. Expect an early "purge" before it settles.',
    tau: 2.2, harsh: 0.55, purge: true, eff: { lines: -0.75, pore: -0.35, pigment: -0.55, acne: -0.45, barrier: 0.10 } },
  niacinamide: { label: 'Niacinamide', color: '#d6cbe6', short: 'Vitamin B3 · calms & balances',
    blurb: 'Vitamin B3. A gentle all-rounder — calms redness, tightens pores and strengthens the barrier for every skin type.',
    tau: 1.3, harsh: 0.0, eff: { redness: -0.55, pore: -0.30, sebum: -0.18, barrier: 0.45, hydration: 0.15, acne: -0.25 } },
  vitaminc:    { label: 'Vitamin C', color: '#f2d484', short: 'Antioxidant · brightens tone',
    blurb: 'An antioxidant that brightens tone and fades dark spots, returning radiance within a few weeks.',
    tau: 0.9, harsh: 0.1, glow: true, eff: { pigment: -0.70, redness: -0.20, barrier: 0.15, lines: -0.15 } },
  hyaluronic:  { label: 'Hyaluronic acid', color: '#c6dcf0', short: 'Humectant · pure hydration',
    blurb: 'A humectant that floods skin with moisture and plumps fine lines. Pure hydration — best for dry, tight skin.',
    tau: 0.35, harsh: 0.0, eff: { hydration: 0.60, barrier: 0.30, lines: -0.20, pore: -0.10 } },
};

export const BASE = {
  oily:        { sebum: 82, hydration: 52, pore: 72, barrier: 58, redness: 30, acne: 5, pigment: 8,  lines: 6,  scars: 0 },
  dry:         { sebum: 22, hydration: 30, pore: 32, barrier: 44, redness: 44, acne: 2, pigment: 10, lines: 22, scars: 0 },
  combination: { sebum: 62, hydration: 48, pore: 56, barrier: 56, redness: 32, acne: 4, pigment: 10, lines: 10, scars: 0 },
  sensitive:   { sebum: 44, hydration: 40, pore: 40, barrier: 34, redness: 66, acne: 3, pigment: 8,  lines: 14, scars: 0 },
  normal:      { sebum: 50, hydration: 64, pore: 38, barrier: 74, redness: 18, acne: 1, pigment: 5,  lines: 8,  scars: 0 },
};

export const METRICS = [
  { key: 'sebum',     label: 'Sebum / oil',    ideal: 46, rng: 52 },
  { key: 'hydration', label: 'Hydration',      ideal: 82, rng: 60 },
  { key: 'pore',      label: 'Pore size',      ideal: 28, rng: 52 },
  { key: 'acne',      label: 'Acne lesions',   ideal: 0,  rng: 22, count: true },
  { key: 'redness',   label: 'Redness',        ideal: 12, rng: 60 },
  { key: 'barrier',   label: 'Barrier health', ideal: 85, rng: 60 },
];

export function computeState(scenario, m) {
  const { skinType, conditions: c, ingredient } = scenario;
  const b = { ...BASE[skinType] };
  if (c.acne)    { b.acne += 16; b.pore += 12; b.redness += 12; b.sebum += 6; }
  if (c.scars)   { b.scars += 58; b.pore += 8; }
  if (c.pigment) { b.pigment += 58; }
  if (c.redness) { b.redness += 26; b.barrier -= 8; }
  if (c.lines)   { b.lines += 55; b.hydration -= 6; b.barrier -= 4; }

  const v = { ...b };
  const ing = ING[ingredient];
  const onset = m <= 0 ? 0 : (1 - Math.exp(-m / ing.tau));
  const SPAN = 55;
  for (const k in ing.eff) {
    if (k === 'acne') v.acne = b.acne * (1 + ing.eff.acne * onset);
    else v[k] = (b[k] || 0) + ing.eff[k] * SPAN * onset;
  }
  if (ing.purge) {
    const tp = 0.8, bump = Math.max(0, (m / tp) * Math.exp(1 - m / tp));
    v.redness += 16 * bump; v.acne += b.acne * 0.55 * bump; v.pore += 4 * bump;
  }
  const mism = 1 + (skinType === 'dry' ? 1.0 : 0) + (skinType === 'sensitive' ? 1.4 : 0) + (c.redness ? 0.5 : 0);
  const irr = ing.harsh * onset * mism;
  v.redness += irr * 20; v.barrier -= irr * 15; v.hydration -= irr * 13;

  const cl = (x) => Math.max(0, Math.min(100, x));
  ['sebum', 'hydration', 'pore', 'barrier', 'redness', 'pigment', 'lines'].forEach(k => v[k] = cl(v[k]));
  v.acne = Math.max(0, v.acne); v.scars = cl(v.scars);
  v.glow = ing.glow ? onset : 0;
  v._irr = irr;
  return v;
}

export function statusLine(cur, base, eff, poured) {
  if (eff <= 0) {
    if (!poured) return 'Choose a skin type & concern, then pour an active to watch it change.';
    return 'Day one — the active has just been applied.';
  }
  if (cur.redness - base.redness > 12 && cur.barrier < base.barrier - 6)
    return 'Signs of irritation — the barrier is under stress from a mismatched active.';
  if (base.acne > 3 && cur.acne < base.acne * 0.6) return 'Breakouts are calming and texture is smoothing.';
  if (base.pigment > 30 && cur.pigment < base.pigment - 12) return 'Tone is brightening as dark spots fade.';
  if (cur.hydration > base.hydration + 12) return 'Skin looks plump, dewy and hydrated.';
  if (base.lines > 30 && cur.lines < base.lines - 12) return 'Fine lines are softening as texture rebuilds.';
  return 'Skin is gradually adjusting to the active.';
}

export function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
export function hex(rgb) { return '#' + rgb.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
export function lerpHex(h1, h2, t) {
  const p = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  return hex(lerp3(p(h1), p(h2), Math.max(0, Math.min(1, t))));
}
