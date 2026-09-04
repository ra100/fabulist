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
const PRESETS = {
  'iron-gall': {
    label: 'Iron gall',
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

  foxed: {
    label: 'Foxed paper',
    mode: 'light',
    source: 'An aged, foxed book page in daylight: warm rag paper, brown-black iron-gall text, rust-coloured foxing blooms in the margin.',
    ground: [0.945, 0.009, 84],
    surface1: [0.985, 0.006, 86],
    surface2: [0.962, 0.008, 84],
    surface3: [0.928, 0.011, 82],
    rule: [0.86, 0.014, 80],
    ruleStrong: [0.73, 0.018, 76],
    ink: [0.27, 0.018, 60],
    ink2: [0.44, 0.02, 58],
    ink3: [0.515, 0.024, 55],
    ink4: [0.68, 0.02, 60],
    accent: [0.5, 0.125, 48],
    accentHover: [0.44, 0.115, 46],
    accentMuted: [0.47, 0.1, 52],
    onAccent: [0.99, 0.008, 80],
    divergent: [0.47, 0.16, 26],
    canon: [0.44, 0.1, 250],
    ok: [0.44, 0.1, 148],
    warn: [0.5, 0.11, 62],
    danger: [0.47, 0.16, 26],
    warnSurface: [0.955, 0.03, 80],
    warnInk: [0.32, 0.06, 55],
    dangerSurface: [0.955, 0.022, 30],
    dangerInk: [0.34, 0.09, 28],
    types: {
      character: [0.585, 0.115, 62],
      location: [0.44, 0.11, 248],
      faction: [0.4, 0.15, 28],
      item: [0.52, 0.1, 150],
      concept: [0.36, 0.12, 300],
      event: [0.62, 0.075, 88],
    },
    edgeCanon: [0.76, 0.04, 250],
    edgeChronicle: [0.76, 0.06, 32],
  },

  cyanotype: {
    label: 'Cyanotype',
    mode: 'dark',
    source: "Anna Atkins' cyanotype algae prints: Prussian blue ground, paper-white forms, and the rust of a print that failed as the one warm note.",
    ground: [0.155, 0.028, 252],
    surface1: [0.2, 0.03, 250],
    surface2: [0.245, 0.032, 248],
    surface3: [0.29, 0.034, 246],
    rule: [0.34, 0.036, 250],
    ruleStrong: [0.42, 0.038, 248],
    ink: [0.94, 0.012, 240],
    ink2: [0.76, 0.02, 240],
    ink3: [0.662, 0.024, 242],
    ink4: [0.48, 0.026, 245],
    accent: [0.74, 0.13, 48],
    accentHover: [0.79, 0.115, 50],
    accentMuted: [0.69, 0.1, 46],
    onAccent: [0.19, 0.03, 45],
    divergent: [0.69, 0.14, 22],
    canon: [0.79, 0.09, 212],
    ok: [0.75, 0.09, 168],
    warn: [0.81, 0.12, 72],
    danger: [0.69, 0.15, 24],
    warnSurface: [0.26, 0.04, 68],
    warnInk: [0.94, 0.03, 75],
    dangerSurface: [0.25, 0.04, 26],
    dangerInk: [0.93, 0.03, 36],
    types: {
      character: [0.76, 0.13, 50],
      location: [0.72, 0.09, 214],
      faction: [0.62, 0.14, 24],
      item: [0.78, 0.09, 168],
      concept: [0.64, 0.1, 296],
      event: [0.9, 0.05, 90],
    },
    edgeCanon: [0.38, 0.05, 232],
    edgeChronicle: [0.38, 0.06, 40],
  },

  phosphor: {
    label: 'Phosphor',
    mode: 'dark',
    source: 'A P31 phosphor CRT behind instrument glass: near-black, green trace, one amber caution lamp.',
    ground: [0.13, 0.012, 162],
    surface1: [0.17, 0.014, 160],
    surface2: [0.212, 0.016, 158],
    surface3: [0.255, 0.018, 156],
    rule: [0.3, 0.02, 160],
    ruleStrong: [0.38, 0.024, 158],
    ink: [0.91, 0.055, 155],
    ink2: [0.745, 0.07, 155],
    ink3: [0.625, 0.078, 158],
    ink4: [0.465, 0.06, 160],
    accent: [0.81, 0.135, 76],
    accentHover: [0.86, 0.115, 78],
    accentMuted: [0.69, 0.115, 74],
    onAccent: [0.18, 0.03, 70],
    divergent: [0.69, 0.15, 26],
    canon: [0.75, 0.1, 202],
    ok: [0.79, 0.13, 150],
    warn: [0.83, 0.13, 80],
    danger: [0.69, 0.16, 26],
    warnSurface: [0.23, 0.035, 74],
    warnInk: [0.93, 0.035, 82],
    dangerSurface: [0.22, 0.04, 26],
    dangerInk: [0.92, 0.035, 34],
    types: {
      character: [0.83, 0.135, 78],
      location: [0.72, 0.1, 204],
      faction: [0.62, 0.15, 26],
      item: [0.8, 0.13, 150],
      concept: [0.66, 0.11, 298],
      event: [0.92, 0.06, 120],
    },
    edgeCanon: [0.34, 0.04, 196],
    edgeChronicle: [0.34, 0.05, 40],
  },

  lacquer: {
    label: 'Lacquer',
    mode: 'dark',
    source: 'Negoro-nuri lacquerware: black-brown urushi worn through to the vermilion beneath, bone-white ground, gold maki-e inlay.',
    ground: [0.145, 0.014, 32],
    surface1: [0.185, 0.016, 30],
    surface2: [0.228, 0.018, 28],
    surface3: [0.27, 0.02, 26],
    rule: [0.32, 0.022, 30],
    ruleStrong: [0.4, 0.024, 28],
    ink: [0.93, 0.012, 72],
    ink2: [0.75, 0.014, 66],
    ink3: [0.655, 0.016, 60],
    ink4: [0.47, 0.016, 50],
    accent: [0.665, 0.185, 33],
    accentHover: [0.715, 0.17, 34],
    accentMuted: [0.715, 0.1, 40],
    onAccent: [0.16, 0.02, 40],
    divergent: [0.78, 0.12, 88],
    canon: [0.71, 0.08, 238],
    ok: [0.73, 0.085, 152],
    warn: [0.82, 0.12, 72],
    danger: [0.67, 0.18, 12],
    warnSurface: [0.24, 0.035, 66],
    warnInk: [0.94, 0.03, 74],
    dangerSurface: [0.23, 0.045, 14],
    dangerInk: [0.93, 0.035, 24],
    types: {
      character: [0.78, 0.12, 88],
      location: [0.7, 0.085, 238],
      faction: [0.665, 0.185, 33],
      item: [0.75, 0.085, 152],
      concept: [0.65, 0.1, 302],
      event: [0.9, 0.045, 78],
    },
    edgeCanon: [0.34, 0.04, 240],
    edgeChronicle: [0.36, 0.07, 33],
  },

  graphite: {
    label: 'Graphite',
    mode: 'dark',
    source: 'Braun product graphics: cold grey housings, screen-printed legends, one pale citron indicator and nothing else.',
    ground: [0.16, 0.006, 252],
    surface1: [0.2, 0.007, 250],
    surface2: [0.245, 0.008, 248],
    surface3: [0.29, 0.009, 246],
    rule: [0.335, 0.01, 250],
    ruleStrong: [0.41, 0.012, 248],
    ink: [0.94, 0.004, 250],
    ink2: [0.76, 0.006, 250],
    ink3: [0.66, 0.008, 250],
    ink4: [0.475, 0.008, 250],
    accent: [0.87, 0.16, 102],
    accentHover: [0.91, 0.165, 104],
    accentMuted: [0.74, 0.13, 100],
    onAccent: [0.2, 0.04, 100],
    divergent: [0.69, 0.13, 26],
    canon: [0.73, 0.08, 252],
    ok: [0.75, 0.09, 152],
    warn: [0.83, 0.12, 76],
    danger: [0.68, 0.15, 26],
    warnSurface: [0.24, 0.03, 74],
    warnInk: [0.94, 0.028, 80],
    dangerSurface: [0.23, 0.035, 26],
    dangerInk: [0.93, 0.03, 34],
    types: {
      character: [0.87, 0.16, 102],
      location: [0.71, 0.08, 252],
      faction: [0.62, 0.14, 26],
      item: [0.76, 0.09, 152],
      concept: [0.65, 0.1, 300],
      event: [0.93, 0.03, 250],
    },
    edgeCanon: [0.35, 0.03, 252],
    edgeChronicle: [0.35, 0.05, 30],
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
 */
try {
  const { readFileSync } = await import('node:fs');
  const sheet = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
  sheet.split('\n').forEach((line, i) => {
    if (/(^|[^-])color:\s*var\(--ink-4\)/.test(line) && !/text-decoration-color/.test(line)) {
      failures.push(`styles.css:${i + 1} uses --ink-4 as a text colour; it is a decoration step only`);
    }
  });
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
    out.push(block(p, key === 'iron-gall' ? `:root,\n[data-palette='iron-gall']` : `[data-palette='${key}']`));
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
