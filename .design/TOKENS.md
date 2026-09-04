# Tokens and colour presets

The token layer is three tiers. **Components read tier 2 only.** They never
reference a raw value, and never name a colour — which is the whole reason a
preset can move any hue without a single component changing.

| Tier | What | Where |
| --- | --- | --- |
| 1 · global | Raw OKLCH values, one set per preset | `.design/palettes.mjs` → generated into `styles.css` |
| 2 · semantic | `--ground` `--ink-*` `--accent*` `--elev-*` `--type-*` … | the generated `[data-palette]` blocks |
| 3 · component | A small number, marked at the rule that owns them | `styles.css` |

Non-colour tiers — space, radius, type, measures, motion — live in `:root` and
are preset-independent.

## Why the values are generated

`.design/palettes.mjs` is the source of truth. It defines every preset in OKLCH,
converts to sRGB, and **fails if any pair falls below WCAG AA**. The CSS is
emitted from it:

```bash
node .design/palettes.mjs          # verify — exits non-zero on any failure
node .design/palettes.mjs --css    # emit the token blocks
```

It currently enforces 258 pairs across 6 presets. What it checks:

- Every text role (`ink`, `ink-2`, `ink-3`, `accent`, `accent-muted`,
  `divergent`, `canon`, `ok`, `warn`, `danger`) against **every surface it can
  land on**, including `surface-3` — which is a text background via button hover
  and the selected choice, and which an earlier hand-audit missed.
- `on-accent` against an accent fill.
- The tinted status surfaces (`warn-*`, `danger-*`) used by the interrupt and
  error panels.
- **sRGB gamut.** Several first-draft values were outside it; high lightness plus
  high chroma in the orange-yellow region clips, and a clipped colour is not the
  colour you designed.
- **Greyscale survival of the graph ramp.** The six entity types must separate by
  relative luminance, not only hue, or the encoding dies in greyscale and for
  colour-vision deficiency. The floor is 0.30 on dark grounds and 0.17 on light,
  because a light ground caps usable luminance near 0.29 to keep every node above
  3:1.
- That **`--ink-4` is never used as a text colour.** It sits at 2.5–3.0:1 by
  design — correct for a strikethrough rule, wrong for anything anyone reads. A
  browser sweep missed this once; the guard greps the stylesheet so it cannot
  regress.

## Naming

`{category}-{role}-{variant}`, and the role is abstract:

```
--accent          not --gold
--divergent       not --rubric      (it means "diverged from canon")
--elev-panel      not --shadow-sm
```

`--gold` was the original name and it is exactly the trap this tier exists to
avoid: the moment a preset's accent is vermilion or citron, a token called
`--gold` is a lie that spreads through every component that reads it.

## The presets

Each is derived from a source with colour relationships someone already
resolved, rather than picked from a wheel. The source is recorded because it is
the tie-breaker for every later colour question.

| Preset | Mode | Source | Register |
| --- | --- | --- | --- |
| **Iron gall** *(default)* | dark | Manuscript ink oxidised to warm brown, gold leaf, red-oxide rubric | Literary, warm, the lineage the app was built to |
| **Foxed paper** | **light** | An aged rag page in daylight, brown-black text, rust foxing | Daylight reading; the only light preset |
| **Cyanotype** | dark | Prussian blue sun-print, paper-white forms, the rust of a failed print | Archival; the strongest warm-on-cool contrast of the set |
| **Phosphor** | dark | Green CRT trace behind instrument glass, one amber caution lamp | Instrument panel; the ink itself is tinted green |
| **Lacquer** | dark | Urushi worn through to the vermilion beneath, gold maki-e inlay | The most saturated and dramatic |
| **Graphite** | dark | Cold grey housings, screen-printed legends, one citron indicator | The most restrained; near-neutral cool |

Temperature and chroma strategy differ per preset, not just hue. That is the
difference between six palettes and one palette in six colours.

### What each preset must supply

Adding a preset means adding an entry to `PRESETS` in `palettes.mjs` and a line
to `PRESETS` in `web/src/palette.ts`. The script will refuse it until it passes.

Beyond the flat roles, two things are mode-dependent and easy to get wrong:

- **Elevation.** Dark presets raise a surface with a 1px top-edge highlight and
  a lighter fill. Light presets have no headroom above the ground, so they raise
  with a real shadow built from the surface colour — never from black. Both ship
  as complete `--elev-*` shadow values, so the component does not know which
  model is in play.
- **Graph dimming.** `--graph-dim` / `--graph-edge-dim` are higher on light
  presets, because a dark node washes out of a near-white plate far faster than a
  light node fades into a dark one. At the dark value, light-mode dimmed nodes
  became invisible.

## Verification

Two layers, and they catch different things.

1. **Static**, `node .design/palettes.mjs` — 258 pairs, gamut, greyscale spread,
   and the `--ink-4` guard. Runs without a browser.
2. **Rendered**, a browser sweep that walks every text node in every view under
   every preset and measures the *actual composited* colours. Latest run:
   **3,282 style instances across 6 presets × 7 views, 0 failures.**

The static pass alone is not enough — it does not know which surface a component
actually puts text on. The rendered pass alone is not enough either; it missed
`--ink-4` and it cannot check gamut. Both.
