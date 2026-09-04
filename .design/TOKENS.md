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

It currently enforces 387 pairs across 9 presets. What it checks:

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

One per genre, because in a role-play engine the palette should match what you
are playing.

**A genre name is a mood, and a mood forbids nothing** — "sci-fi" on its own
permits every option still on the table, which is how you end up at blue-and-cyan
and how romance ends up bubblegum pink. So each preset is pinned to a *specific
artefact* inside its genre. That source is recorded, and it is the tie-breaker for
every later colour question.

| Preset | Genre | Mode | Source |
| --- | --- | --- | --- |
| **Chronicle** *(default)* | historical · literary | dark | Iron-gall ink oxidised to warm brown, gold leaf, red-oxide rubric |
| **Starship** | science fiction · hard | dark | Apollo command-module panels and the interiors of *2001*: one cyan trace, caution orange |
| **Neon** | science fiction · cyberpunk | dark | Rain-lit signage over Kowloon, Syd Mead |
| **Grimoire** | fantasy · high | dark | Tooled leather, verdigris on bronze, Rackham's muted wash |
| **Ember** | fantasy · dark | dark | Forge scale and Beksiński's ash, under cold bone light |
| **Nocturne** | horror · gothic | dark | Doré engravings by candlelight, foxed mourning stationery |
| **Gaslight** | mystery · noir | dark | Sodium street lamps in fog, noir night stock |
| **Ribbon** | romance | **light** | Wedgwood jasperware, marbled endpapers, pressed flowers in a keepsake album |
| **Meadow** | casual · slice of life | **light** | Beatrix Potter's washes over picture-book offset, on linen |

Where the discipline shows up concretely:

- **Neon** is the preset most at risk of being the category average. Two rules
  keep it out: the ground is deep indigo rather than black, and **only the magenta
  runs hot** — cyan is held back for the canon layer, so the screen never becomes
  the magenta-and-cyan wash that reads as stock cyberpunk.
- **Ribbon** is light and warm rather than pink-on-white, with plum reserved for
  divergence. Romance is the cosy register, so daylight is the correct choice, not
  a saturated hue.
- **Nocturne** carries almost no chroma anywhere except one candle-gold accent,
  with oxblood underneath it for divergence. Restraint is what makes it gothic
  rather than Halloween.
- **Ember** and **Grimoire** are both fantasy and deliberately opposite: warm ash
  under cold bone light versus cool ink-green under warm gold.

Every preset still obeys the lineage rules: one accent on a three-appearance
budget, a second colour reserved for divergence from canon, tinted neutrals, and
no colour named in a component. A preset may change the hue; it may not change
the discipline.

Renaming from the earlier material-named set (`iron-gall`, `cyanotype`, …) is
handled by a migration map in `web/src/palette.ts`, so an existing stored choice
maps forward rather than resetting.

### What each preset must supply

Adding a preset means adding an entry to `PRESETS` in `palettes.mjs` (with its
`genre` and `source`) and a line to `PRESETS` in `web/src/palette.ts`. The script will refuse it until it passes.

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

1. **Static**, `node .design/palettes.mjs` — 387 pairs, gamut, greyscale spread,
   and the `--ink-4` guard. Runs without a browser.
2. **Rendered**, a browser sweep that walks every text node in every view under
   every preset and measures the *actual composited* colours. Latest run:
   **5,067 composited text instances across 9 presets × 7 views, 0 failures.**

The static pass alone is not enough — it does not know which surface a component
actually puts text on. The rendered pass alone is not enough either; it missed
`--ink-4` and it cannot check gamut. Both.
