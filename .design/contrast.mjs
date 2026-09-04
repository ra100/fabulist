// OKLCH -> sRGB -> WCAG contrast, to verify palette choices before committing them.
function oklchToSrgb(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, v));
  };
  return [enc(r), enc(g), enc(bb)];
}
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const relLum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (c1, c2) => {
  const a = relLum(c1), b = relLum(c2);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const hex = ([r, g, b]) =>
  '#' + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');

const tok = {
  ground:    [0.145, 0.008, 68],
  surface1:  [0.190, 0.009, 68],
  surface2:  [0.232, 0.010, 68],
  surface3:  [0.275, 0.011, 68],
  rule:      [0.320, 0.012, 68],
  ruleStrong:[0.400, 0.014, 68],
  ink:       [0.930, 0.014, 82],
  ink2:      [0.740, 0.016, 78],
  ink3:      [0.620, 0.016, 76],
  gold:      [0.800, 0.130, 80],
  goldDim:   [0.680, 0.110, 78],
  rubric:    [0.660, 0.130, 32],
  canon:     [0.700, 0.075, 248],
  ok:        [0.700, 0.080, 145],
  warn:      [0.800, 0.115, 60],
  danger:    [0.660, 0.140, 28],
};
const rgb = Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, oklchToSrgb(...v)]));

console.log('token       hex       vs ground  vs surface1  vs surface2');
for (const k of Object.keys(tok)) {
  const r1 = ratio(rgb[k], rgb.ground).toFixed(2);
  const r2 = ratio(rgb[k], rgb.surface1).toFixed(2);
  const r3 = ratio(rgb[k], rgb.surface2).toFixed(2);
  console.log(k.padEnd(11), hex(rgb[k]).padEnd(9), r1.padStart(7), r2.padStart(11), r3.padStart(12));
}
console.log('\ndark text on gold fill:',
  ratio(oklchToSrgb(0.20, 0.03, 75), rgb.gold).toFixed(2));
console.log('surface separation ground->surface1:', ratio(rgb.surface1, rgb.ground).toFixed(3));
console.log('surface separation surface1->surface2:', ratio(rgb.surface2, rgb.surface1).toFixed(3));

// graph type ramp: must separate in greyscale (relative luminance spread)
const graph = {
  Character: [0.800, 0.130, 80],
  Location:  [0.660, 0.080, 245],
  Faction:   [0.580, 0.130, 30],
  Item:      [0.745, 0.075, 145],
  Concept:   [0.620, 0.090, 300],
  Event:     [0.870, 0.055, 95],
};
console.log('\ngraph type      hex      lum    vs surface1');
for (const [k, v] of Object.entries(graph)) {
  const c = oklchToSrgb(...v);
  console.log(k.padEnd(14), hex(c).padEnd(9), relLum(c).toFixed(3).padStart(6),
    ratio(c, rgb.surface1).toFixed(2).padStart(6));
}
