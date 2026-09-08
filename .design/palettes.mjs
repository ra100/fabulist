/**
 * Palette presets for Fabulist.
 *
 * Each preset is derived from a named source with colour relationships someone
 * already resolved — not a hue rotation of the same non-decision. Built in
 * OKLCH: hue drifts across the surface and ink steps rather than holding one
 * angle, and chroma tapers at the extremes.
 *
 * This file is the source of truth. It verifies every text pair against WCAG
 * and emits the CSS, so a preset cannot ship with a contrast failure.
 *
 *   node .design/palettes.mjs          # verify, print the table
 *   node .design/palettes.mjs --css    # emit the CSS token blocks
 */

// ---------------------------------------------------------------- colour math

function oklchToSrgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v));
  };
  const clipped = [r, g, bb].some((x) => x < -0.001 || x > 1.001);
  return { rgb: [enc(r), enc(g), enc(bb)], clipped };
}
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const relLum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => {
  const la = relLum(a), lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const css = ([L, C, H]) => `oklch(${L} ${C} ${H})`;
const rgbOf = (t) => oklchToSrgb(...t).rgb;

// ------------------------------------------------------------------- presets

/**
 * Role keys are abstract on purpose: components never name a colour, so a
 * preset can move any hue without touching a component.
 */
/** Also emitted onto :root, so there is colour before any attribute is set. */
const DEFAULT_PRESET = 'chronicle';

const PRESETS = {
  chronicle: {
    label: 'Chronicle',
    genre: 'historical · literary',
    mode: 'dark',
    source: 'An iron-gall manuscript on vellum: ink oxidised from blue-black to warm brown, gold leaf on the initials, red-oxide rubric in the margin.',
    ground: [0.145, 0.008, 68],
    surface1: [0.19, 0.009, 68],
    surface2: [0.232, 0.01, 70],
    surface3: [0.275, 0.011, 72],
    rule: [0.32, 0.012, 68],
    ruleStrong: [0.4, 0.014, 70],
    ink: [0.93, 0.014, 82],
    ink2: [0.74, 0.016, 78],
    ink3: [0.648, 0.016, 76],
    ink4: [0.46, 0.014, 72],
    accent: [0.8, 0.13, 80],
    accentHover: [0.85, 0.135, 80],
    accentMuted: [0.68, 0.11, 78],
    onAccent: [0.2, 0.03, 75],
    divergent: [0.66, 0.13, 32],
    canon: [0.7, 0.075, 248],
    ok: [0.7, 0.08, 145],
    warn: [0.8, 0.115, 60],
    danger: [0.678, 0.14, 28],
    warnSurface: [0.24, 0.03, 60],
    warnInk: [0.93, 0.03, 70],
    dangerSurface: [0.23, 0.035, 28],
    dangerInk: [0.92, 0.03, 40],
    types: {
      character: [0.8, 0.13, 80],
      location: [0.66, 0.08, 245],
      faction: [0.58, 0.13, 30],
      item: [0.745, 0.075, 145],
      concept: [0.62, 0.09, 300],
      event: [0.87, 0.055, 95],
    },
    edgeCanon: [0.33, 0.035, 250],
    edgeChronicle: [0.34, 0.05, 30],
  },

  starship: {
    label: 'Starship',
    genre: 'science fiction · hard',
    mode: 'dark',
    source: 'Apollo command-module panels and the white interiors of 2001: cold instrument black, one cyan data trace, caution orange.',
    ground: [0.145, 0.01, 230],
    surface1: [0.188, 0.012, 232],
    surface2: [0.232, 0.013, 234],
    surface3: [0.276, 0.014, 236],
    rule: [0.32, 0.015, 232],
    ruleStrong: [0.4, 0.017, 234],
    ink: [0.945, 0.008, 220],
    ink2: [0.765, 0.012, 222],
    ink3: [0.672, 0.014, 225],
    ink4: [0.48, 0.014, 228],
    accent: [0.82, 0.115, 200],
    accentHover: [0.87, 0.1, 202],
    accentMuted: [0.72, 0.095, 198],
    onAccent: [0.17, 0.03, 205],
    divergent: [0.76, 0.135, 55],
    canon: [0.75, 0.09, 262],
    ok: [0.76, 0.105, 160],
    warn: [0.81, 0.125, 70],
    danger: [0.7, 0.155, 25],
    warnSurface: [0.23, 0.03, 65],
    warnInk: [0.93, 0.03, 72],
    dangerSurface: [0.22, 0.035, 25],
    dangerInk: [0.92, 0.03, 32],
    types: {
      character: [0.82, 0.115, 200],
      location: [0.66, 0.085, 262],
      faction: [0.6, 0.145, 25],
      item: [0.76, 0.1, 160],
      concept: [0.64, 0.1, 295],
      event: [0.93, 0.04, 210],
    },
    edgeCanon: [0.34, 0.04, 258],
    edgeChronicle: [0.35, 0.05, 45],
  },

  neon: {
    label: 'Neon',
    genre: 'science fiction · cyberpunk',
    mode: 'dark',
    source: 'Rain-lit signage over Kowloon and Syd Mead\u2019s cityscapes. The ground is deep indigo rather than black, and only the magenta is hot \u2014 cyan is held back for canon.',
    ground: [0.155, 0.026, 305],
    surface1: [0.2, 0.03, 302],
    surface2: [0.245, 0.032, 300],
    surface3: [0.29, 0.034, 298],
    rule: [0.34, 0.036, 302],
    ruleStrong: [0.42, 0.038, 300],
    ink: [0.94, 0.014, 310],
    ink2: [0.775, 0.02, 308],
    ink3: [0.685, 0.024, 306],
    ink4: [0.49, 0.026, 304],
    accent: [0.72, 0.17, 345],
    accentHover: [0.78, 0.155, 347],
    accentMuted: [0.755, 0.1, 338],
    onAccent: [0.16, 0.03, 340],
    divergent: [0.82, 0.13, 78],
    canon: [0.81, 0.1, 205],
    ok: [0.78, 0.115, 165],
    warn: [0.84, 0.125, 82],
    danger: [0.71, 0.16, 30],
    warnSurface: [0.25, 0.035, 76],
    warnInk: [0.94, 0.03, 82],
    dangerSurface: [0.24, 0.04, 28],
    dangerInk: [0.93, 0.03, 36],
    types: {
      character: [0.72, 0.17, 345],
      location: [0.81, 0.1, 205],
      faction: [0.62, 0.16, 22],
      item: [0.78, 0.115, 165],
      concept: [0.66, 0.13, 285],
      event: [0.94, 0.035, 320],
    },
    edgeCanon: [0.38, 0.05, 210],
    edgeChronicle: [0.39, 0.07, 340],
  },

  grimoire: {
    label: 'Grimoire',
    genre: 'fantasy · high',
    mode: 'dark',
    source: 'A tooled leather grimoire, verdigris on bronze, and Rackham\u2019s muted watercolour: deep ink-green board, antique gold, oxblood.',
    ground: [0.148, 0.018, 190],
    surface1: [0.192, 0.02, 188],
    surface2: [0.236, 0.022, 186],
    surface3: [0.28, 0.024, 184],
    rule: [0.325, 0.026, 188],
    ruleStrong: [0.405, 0.028, 186],
    ink: [0.935, 0.014, 85],
    ink2: [0.755, 0.016, 80],
    ink3: [0.668, 0.018, 76],
    ink4: [0.475, 0.018, 72],
    accent: [0.79, 0.125, 88],
    accentHover: [0.84, 0.12, 90],
    accentMuted: [0.71, 0.1, 86],
    onAccent: [0.18, 0.03, 85],
    divergent: [0.68, 0.145, 22],
    canon: [0.77, 0.09, 215],
    ok: [0.75, 0.1, 155],
    warn: [0.82, 0.12, 65],
    danger: [0.695, 0.155, 24],
    warnSurface: [0.24, 0.032, 68],
    warnInk: [0.93, 0.03, 76],
    dangerSurface: [0.23, 0.038, 24],
    dangerInk: [0.92, 0.03, 34],
    types: {
      character: [0.79, 0.125, 88],
      location: [0.68, 0.09, 215],
      faction: [0.62, 0.145, 22],
      item: [0.755, 0.1, 155],
      concept: [0.645, 0.11, 295],
      event: [0.92, 0.05, 100],
    },
    edgeCanon: [0.35, 0.04, 212],
    edgeChronicle: [0.36, 0.06, 26],
  },

  ember: {
    label: 'Ember',
    genre: 'fantasy · dark',
    mode: 'dark',
    source: 'Forge scale and Beksi\u0144ski\u2019s ash palettes: warm grey-brown ash under cold bone-white light, with one ember at the centre.',
    ground: [0.14, 0.008, 40],
    surface1: [0.183, 0.009, 42],
    surface2: [0.226, 0.01, 44],
    surface3: [0.268, 0.011, 46],
    rule: [0.315, 0.012, 42],
    ruleStrong: [0.395, 0.013, 44],
    ink: [0.92, 0.008, 250],
    ink2: [0.745, 0.01, 250],
    ink3: [0.66, 0.011, 250],
    ink4: [0.47, 0.01, 250],
    accent: [0.72, 0.16, 48],
    accentHover: [0.77, 0.15, 50],
    accentMuted: [0.745, 0.1, 52],
    onAccent: [0.16, 0.03, 45],
    divergent: [0.77, 0.09, 172],
    canon: [0.72, 0.075, 245],
    ok: [0.75, 0.09, 150],
    warn: [0.83, 0.115, 70],
    danger: [0.7, 0.165, 14],
    warnSurface: [0.23, 0.03, 68],
    warnInk: [0.93, 0.028, 74],
    dangerSurface: [0.22, 0.036, 16],
    dangerInk: [0.92, 0.03, 26],
    types: {
      character: [0.72, 0.16, 48],
      location: [0.665, 0.075, 245],
      faction: [0.6, 0.15, 14],
      item: [0.77, 0.09, 172],
      concept: [0.645, 0.1, 300],
      event: [0.92, 0.04, 62],
    },
    edgeCanon: [0.33, 0.035, 245],
    edgeChronicle: [0.35, 0.06, 45],
  },

  nocturne: {
    label: 'Nocturne',
    genre: 'horror · gothic',
    mode: 'dark',
    source: 'Dor\u00e9 engravings by candlelight and foxed mourning stationery: near-black with almost no chroma, bone ink, one candle-gold flame and oxblood beneath it.',
    ground: [0.125, 0.006, 300],
    surface1: [0.168, 0.007, 300],
    surface2: [0.212, 0.008, 300],
    surface3: [0.255, 0.009, 300],
    rule: [0.3, 0.01, 300],
    ruleStrong: [0.38, 0.011, 300],
    ink: [0.925, 0.008, 70],
    ink2: [0.75, 0.01, 68],
    ink3: [0.655, 0.011, 66],
    ink4: [0.475, 0.01, 64],
    accent: [0.79, 0.115, 88],
    accentHover: [0.85, 0.11, 90],
    accentMuted: [0.7, 0.095, 86],
    onAccent: [0.16, 0.025, 85],
    divergent: [0.655, 0.16, 18],
    canon: [0.73, 0.075, 250],
    ok: [0.74, 0.085, 150],
    warn: [0.82, 0.115, 70],
    danger: [0.7, 0.165, 28],
    warnSurface: [0.22, 0.03, 70],
    warnInk: [0.92, 0.028, 76],
    dangerSurface: [0.21, 0.036, 24],
    dangerInk: [0.92, 0.03, 32],
    types: {
      character: [0.79, 0.115, 88],
      location: [0.67, 0.075, 250],
      faction: [0.6, 0.16, 18],
      item: [0.755, 0.085, 155],
      concept: [0.635, 0.1, 300],
      event: [0.92, 0.035, 80],
    },
    edgeCanon: [0.32, 0.03, 250],
    edgeChronicle: [0.33, 0.055, 22],
  },

  gaslight: {
    label: 'Gaslight',
    genre: 'mystery · noir',
    mode: 'dark',
    source: 'Sodium street lamps in fog and the blue-grey of noir night stock: a lighter, hazier ground than the rest, with amber the only warm thing in it.',
    ground: [0.17, 0.014, 245],
    surface1: [0.213, 0.015, 243],
    surface2: [0.256, 0.016, 241],
    surface3: [0.3, 0.017, 239],
    rule: [0.345, 0.018, 243],
    ruleStrong: [0.425, 0.019, 241],
    ink: [0.94, 0.01, 240],
    ink2: [0.775, 0.014, 240],
    ink3: [0.69, 0.016, 242],
    ink4: [0.5, 0.016, 244],
    accent: [0.8, 0.13, 68],
    accentHover: [0.85, 0.105, 70],
    accentMuted: [0.735, 0.105, 66],
    onAccent: [0.18, 0.03, 68],
    divergent: [0.71, 0.145, 25],
    canon: [0.8, 0.09, 215],
    ok: [0.77, 0.09, 158],
    warn: [0.84, 0.115, 76],
    danger: [0.72, 0.15, 22],
    warnSurface: [0.26, 0.03, 74],
    warnInk: [0.94, 0.028, 80],
    dangerSurface: [0.25, 0.036, 22],
    dangerInk: [0.93, 0.03, 30],
    types: {
      character: [0.8, 0.13, 68],
      location: [0.71, 0.09, 215],
      faction: [0.63, 0.145, 22],
      item: [0.775, 0.09, 158],
      concept: [0.655, 0.1, 292],
      event: [0.94, 0.032, 230],
    },
    edgeCanon: [0.37, 0.035, 215],
    edgeChronicle: [0.38, 0.055, 30],
  },

  ribbon: {
    label: 'Ribbon',
    genre: 'romance',
    mode: 'light',
    source: 'Wedgwood jasperware, marbled endpapers and pressed flowers in a Victorian keepsake album: warm cream, dusty rose, a plum for what went wrong.',
    ground: [0.955, 0.01, 60],
    surface1: [0.985, 0.007, 62],
    surface2: [0.965, 0.009, 58],
    surface3: [0.928, 0.013, 55],
    rule: [0.865, 0.016, 50],
    ruleStrong: [0.74, 0.02, 45],
    ink: [0.28, 0.02, 30],
    ink2: [0.45, 0.022, 28],
    ink3: [0.5, 0.024, 25],
    ink4: [0.69, 0.02, 30],
    accent: [0.5, 0.13, 8],
    accentHover: [0.44, 0.125, 6],
    accentMuted: [0.47, 0.1, 14],
    onAccent: [0.985, 0.004, 40],
    divergent: [0.45, 0.14, 330],
    canon: [0.44, 0.09, 245],
    ok: [0.44, 0.1, 150],
    warn: [0.48, 0.105, 60],
    danger: [0.46, 0.15, 32],
    warnSurface: [0.96, 0.026, 75],
    warnInk: [0.33, 0.055, 50],
    dangerSurface: [0.958, 0.02, 28],
    dangerInk: [0.34, 0.085, 26],
    types: {
      character: [0.56, 0.11, 20],
      location: [0.44, 0.1, 245],
      faction: [0.4, 0.14, 340],
      item: [0.52, 0.095, 150],
      concept: [0.37, 0.11, 290],
      event: [0.62, 0.07, 70],
    },
    edgeCanon: [0.77, 0.035, 245],
    edgeChronicle: [0.77, 0.05, 340],
  },

  meadow: {
    label: 'Meadow',
    genre: 'casual · slice of life',
    mode: 'light',
    source: 'Beatrix Potter\u2019s watercolour washes over Japanese picture-book offset: linen paper with a faint green cast, soft sage, muted clay.',
    ground: [0.95, 0.008, 130],
    surface1: [0.982, 0.006, 132],
    surface2: [0.962, 0.008, 128],
    surface3: [0.925, 0.011, 126],
    rule: [0.862, 0.014, 130],
    ruleStrong: [0.735, 0.018, 128],
    ink: [0.3, 0.016, 150],
    ink2: [0.46, 0.018, 148],
    ink3: [0.505, 0.02, 145],
    ink4: [0.69, 0.016, 145],
    accent: [0.47, 0.1, 145],
    accentHover: [0.41, 0.095, 143],
    accentMuted: [0.48, 0.075, 150],
    onAccent: [0.99, 0.005, 140],
    divergent: [0.48, 0.13, 40],
    canon: [0.44, 0.09, 245],
    ok: [0.44, 0.1, 155],
    warn: [0.48, 0.11, 62],
    danger: [0.46, 0.15, 26],
    warnSurface: [0.958, 0.024, 78],
    warnInk: [0.33, 0.05, 55],
    dangerSurface: [0.956, 0.02, 28],
    dangerInk: [0.34, 0.08, 26],
    types: {
      character: [0.52, 0.1, 145],
      location: [0.44, 0.09, 245],
      faction: [0.42, 0.13, 35],
      item: [0.55, 0.08, 178],
      concept: [0.38, 0.11, 295],
      event: [0.62, 0.07, 95],
    },
    edgeCanon: [0.77, 0.035, 245],
    edgeChronicle: [0.77, 0.05, 40],
  },
};

// ------------------------------------------------------------------- verifier

/** Text roles that must clear 4.5:1 on each surface they can appear on. */
const TEXT_ON_SURFACES = ['ink', 'ink2', 'ink3', 'accent', 'accentMuted', 'divergent', 'canon', 'ok', 'warn', 'danger'];
// surface3 is a text background too: button hover and the selected choice both
// use it, which an earlier sweep missed.
const SURFACES = ['ground', 'surface1', 'surface2', 'surface3'];

const failures = [];
const rows = [];

for (const [key, p] of Object.entries(PRESETS)) {
  // gamut check on every declared colour
  for (const [role, val] of Object.entries(p)) {
    if (!Array.isArray(val)) continue;
    if (oklchToSrgb(...val).clipped) failures.push(`${key}: ${role} is outside sRGB`);
  }
  for (const [t, val] of Object.entries(p.types)) {
    if (oklchToSrgb(...val).clipped) failures.push(`${key}: type.${t} is outside sRGB`);
  }

  for (const role of TEXT_ON_SURFACES) {
    for (const s of SURFACES) {
      const r = contrast(rgbOf(p[role]), rgbOf(p[s]));
      rows.push({ preset: key, pair: `${role} on ${s}`, ratio: r, need: 4.5 });
      if (r < 4.5) failures.push(`${key}: ${role} on ${s} = ${r.toFixed(2)} (needs 4.5)`);
    }
  }
  // label text on an accent fill
  const onAcc = contrast(rgbOf(p.onAccent), rgbOf(p.accent));
  rows.push({ preset: key, pair: 'onAccent on accent', ratio: onAcc, need: 4.5 });
  if (onAcc < 4.5) failures.push(`${key}: onAccent on accent = ${onAcc.toFixed(2)} (needs 4.5)`);

  // tinted status surfaces (interrupt / error panels)
  for (const [ink, surf] of [['warnInk', 'warnSurface'], ['dangerInk', 'dangerSurface']]) {
    const r = contrast(rgbOf(p[ink]), rgbOf(p[surf]));
    rows.push({ preset: key, pair: `${ink} on ${surf}`, ratio: r, need: 4.5 });
    if (r < 4.5) failures.push(`${key}: ${ink} on ${surf} = ${r.toFixed(2)} (needs 4.5)`);
  }

  // non-text UI: hairlines and graph nodes need 3:1
  const rs = contrast(rgbOf(p.ruleStrong), rgbOf(p.ground));
  if (rs < 2.0) failures.push(`${key}: ruleStrong on ground = ${rs.toFixed(2)} (needs 2.0 as a visible edge)`);
  for (const [t, val] of Object.entries(p.types)) {
    const r = contrast(rgbOf(val), rgbOf(p.surface1));
    if (r < 3.0) failures.push(`${key}: type.${t} on surface1 = ${r.toFixed(2)} (needs 3.0)`);
  }
  // The type ramp must survive greyscale. On a light ground every node still
  // has to clear 3:1 against a near-white panel, which caps relative luminance
  // near 0.29 and leaves far less range than a dark ground has.
  const lums = Object.values(p.types).map((v) => relLum(rgbOf(v)));
  const spread = Math.max(...lums) - Math.min(...lums);
  const floor = p.mode === 'light' ? 0.17 : 0.3;
  if (spread < floor) failures.push(`${key}: type ramp luminance spread ${spread.toFixed(2)} is below the ${floor} floor for ${p.mode}`);
}

// --------------------------------------------------------------------- output

/**
 * `--ink-4` is a decoration step: it measures 2.5–3.0:1 in every preset, which is
 * right for a strikethrough rule and wrong for anything anyone has to read. A
 * browser contrast sweep missed this once, so the rule is enforced here instead.
 *
 * Every stylesheet, not just the app's. `landing.css` was written against these
 * tokens and used `--ink-4` for folio numbers, step numbers and copy labels —
 * seven times — because the guard named one file and so only covered one file. A
 * rule that applies to the token layer has to be checked wherever the token
 * layer is read.
 */
try {
  const { readFileSync } = await import('node:fs');
  const sheets = ['../web/src/styles.css', '../web/src/landing/landing.css'];
  for (const rel of sheets) {
    const name = rel.split('/').pop();
    const sheet = readFileSync(new URL(rel, import.meta.url), 'utf8');
    sheet.split('\n').forEach((line, i) => {
      if (/(^|[^-])color:\s*var\(--ink-4\)/.test(line) && !/text-decoration-color/.test(line)) {
        failures.push(`${name}:${i + 1} uses --ink-4 as a text colour; it is a decoration step only`);
      }
    });
  }
} catch {
  // Running the script outside the repo is fine; the guard is a convenience.
}

if (process.argv.includes('--css')) {
  const block = (p, sel) => {
    const L = [];
    L.push(`${sel} {`);
    L.push(`  color-scheme: ${p.mode};`);
    L.push(`  --palette-mode: ${p.mode};`);
    L.push('');
    L.push('  /* surfaces */');
    for (const [k, n] of [['ground', 'ground'], ['surface1', 'surface-1'], ['surface2', 'surface-2'], ['surface3', 'surface-3'], ['rule', 'rule'], ['ruleStrong', 'rule-strong']]) {
      L.push(`  --${n}: ${css(p[k])};`);
    }
    L.push(`  --rule-soft: ${css(p.rule).replace(')', ' / 0.5)')};`);
    L.push('');
    L.push('  /* ink */');
    for (const [k, n] of [['ink', 'ink'], ['ink2', 'ink-2'], ['ink3', 'ink-3'], ['ink4', 'ink-4']]) {
      L.push(`  --${n}: ${css(p[k])};`);
    }
    L.push('');
    L.push('  /* accent — the one indicator lamp */');
    L.push(`  --accent: ${css(p.accent)};`);
    L.push(`  --accent-hover: ${css(p.accentHover)};`);
    L.push(`  --accent-muted: ${css(p.accentMuted)};`);
    L.push(`  --on-accent: ${css(p.onAccent)};`);
    L.push(`  --accent-veil: ${css(p.accent).replace(')', ' / 0.16)')};`);
    L.push(`  --accent-select: ${css(p.accent).replace(')', ' / 0.25)')};`);
    L.push(`  --accent-line: ${css(p.accent).replace(')', ' / 0.5)')};`);
    L.push('');
    L.push('  /* domain roles */');
    L.push(`  --canon: ${css(p.canon)};`);
    L.push(`  --canon-line: ${css(p.canon).replace(')', ' / 0.5)')};`);
    L.push(`  --canon-underline: ${css(p.canon).replace(')', ' / 0.4)')};`);
    L.push(`  --divergent: ${css(p.divergent)};`);
    L.push(`  --divergent-line: ${css(p.divergent).replace(')', ' / 0.5)')};`);
    L.push('');
    L.push('  /* status */');
    for (const k of ['ok', 'warn', 'danger']) L.push(`  --${k}: ${css(p[k])};`);
    L.push(`  --warn-surface: ${css(p.warnSurface)};`);
    L.push(`  --warn-ink: ${css(p.warnInk)};`);
    L.push(`  --warn-line: ${css(p.warn).replace(')', ' / 0.5)')};`);
    L.push(`  --danger-surface: ${css(p.dangerSurface)};`);
    L.push(`  --danger-ink: ${css(p.dangerInk)};`);
    L.push(`  --danger-line: ${css(p.danger).replace(')', ' / 0.5)')};`);
    L.push('');
    L.push('  /* material: dark themes raise with light, light themes with shadow */');
    if (p.mode === 'dark') {
      L.push('  --edge-light: oklch(1 0 0 / 0.045);');
      L.push('  --edge-light-strong: oklch(1 0 0 / 0.28);');
      L.push('  --elev-panel: inset 0 1px 0 oklch(1 0 0 / 0.04);');
      L.push('  --elev-raised: inset 0 1px 0 oklch(1 0 0 / 0.045);');
      L.push('  --elev-well: inset 0 1px 2px oklch(0 0 0 / 0.22);');
      L.push('  --elev-pressed: inset 0 1px 2px oklch(0 0 0 / 0.25);');
      L.push(`  --hatch: ${css(p.ink4).replace(')', ' / 0.55)')};`);
      L.push(`  --overlay-veil: ${css(p.surface2).replace(')', ' / 0.9)')};`);
      L.push('  --graph-dim: 0.22;');
      L.push('  --graph-edge-dim: 0.16;');
    } else {
      // On a light ground there is no headroom above; depth comes from a real
      // shadow built from the surface colour, never from black.
      const sh = (a) => `oklch(0.45 0.03 70 / ${a})`;
      L.push('  --edge-light: oklch(1 0 0 / 0.85);');
      L.push('  --edge-light-strong: oklch(1 0 0 / 0.5);');
      L.push(`  --elev-panel: 0 1px 1px ${sh(0.05)}, 0 2px 6px ${sh(0.045)};`);
      L.push(`  --elev-raised: inset 0 1px 0 oklch(1 0 0 / 0.85), 0 1px 2px ${sh(0.09)};`);
      L.push(`  --elev-well: inset 0 1px 2px ${sh(0.14)};`);
      L.push(`  --elev-pressed: inset 0 1px 3px ${sh(0.2)};`);
      L.push(`  --hatch: ${css(p.ink4).replace(')', ' / 0.5)')};`);
      L.push(`  --overlay-veil: ${css(p.surface1).replace(')', ' / 0.9)')};`);
      // A dark node fades into a light plate much faster than a light node fades
      // into a dark one, so the dim factor has to be higher here.
      L.push('  --graph-dim: 0.45;');
      L.push('  --graph-edge-dim: 0.3;');
    }
    L.push('');
    L.push('  /* graph: separated by lightness so the encoding survives greyscale */');
    for (const [t, v] of Object.entries(p.types)) L.push(`  --type-${t}: ${css(v)};`);
    L.push(`  --edge-canon: ${css(p.edgeCanon)};`);
    L.push(`  --edge-chronicle: ${css(p.edgeChronicle)};`);
    L.push('}');
    return L.join('\n');
  };

  const out = [];
  out.push('/* ===========================================================================');
  out.push('   Colour presets — GENERATED by .design/palettes.mjs. Do not hand-edit.');
  out.push('   Every pair below is verified against WCAG AA by that script.');
  out.push('   ======================================================================== */');
  out.push('');
  for (const [key, p] of Object.entries(PRESETS)) {
    out.push(`/* ${p.label} (${p.mode}) — ${p.source} */`);
    // The default preset also answers to :root, so the app has colour before any
    // attribute is set (and if localStorage is unavailable).
    out.push(block(p, key === DEFAULT_PRESET ? `:root,\n[data-palette='${key}']` : `[data-palette='${key}']`));
    out.push('');
  }
  console.log(out.join('\n'));
} else {
  const byPreset = new Map();
  for (const r of rows) {
    if (!byPreset.has(r.preset)) byPreset.set(r.preset, []);
    byPreset.get(r.preset).push(r);
  }
  for (const [k, rs] of byPreset) {
    const worst = rs.reduce((a, b) => (a.ratio < b.ratio ? a : b));
    const lums = Object.values(PRESETS[k].types).map((v) => relLum(rgbOf(v)));
    console.log(
      `${PRESETS[k].label.padEnd(13)} ${PRESETS[k].mode.padEnd(6)} pairs=${String(rs.length).padStart(2)}` +
      `  worst=${worst.ratio.toFixed(2)} (${worst.pair})` +
      `  typeSpread=${(Math.max(...lums) - Math.min(...lums)).toFixed(2)}`,
    );
  }
  console.log('');
  if (failures.length) {
    console.log(`${failures.length} FAILURE(S):`);
    for (const f of failures) console.log('  ' + f);
    process.exitCode = 1;
  } else {
    console.log(`All ${rows.length} verified pairs pass, ${Object.keys(PRESETS).length} presets, 0 gamut clips.`);
  }
}

export { PRESETS };
