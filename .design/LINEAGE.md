# Lineage: the chronicle and the instrument

Editorial/print — specifically the monastic chronicle — crossed with the technical
instrument panel. Chosen because the content is literally a book being written by a
machine that shows its work, and those are the two things it has to look like at once.

## Reference artifacts

1. **An iron-gall-ink chronicle page on vellum** — ruled margins, folio numbers
   hanging in the gutter, rubricated initials and marginal notes in red-oxide
   (minium), ink that has oxidised from blue-black toward warm brown.
2. **Bloomberg Businessweek chart pages / Tufte's plates** — hairline rules
   instead of boxes, tracked small-caps labels, tabular figures, data-ink
   discipline, dense tables that stay legible.
3. **Braun and Teenage Engineering instrument panels** — engraved labels, physical
   edge bevels, scales with tick marks, exactly one amber indicator lamp.

## Five rules this imposes

1. **Type — three registers, each owning a domain, and every face chosen.**
   *Hoefler Text* carries the editorial voice: the narrative **and its apparatus**
   — section labels, running heads, the move line — because it has real small caps,
   and real small caps are how a book sets a label. *Big Caslon* appears once per
   scene on the rubricated initial, the way a manuscript hand differs from its text
   hand. *Seravek* is a humanist sans for machine chrome that holds at 11px without
   being the operating system's default. *PT Mono* marks machine values. Tabular
   figures anywhere numbers stack; tracking and leading both inverse to size.

   *Amended from the original rule, which said serif was for narrative only. That
   was a simplification: small-caps labels set in the text serif are ordinary book
   practice, and the earlier version left every face at a system fallback — which
   is the single largest reason the result read as anonymous.*
2. **Colour — iron gall on vellum.** Warm, low chroma, built in OKLCH with tinted
   neutrals at hue 68–82. One accent (gold leaf) with a budget of three appearances
   per view. Red-oxide rubric is the second colour and means divergence from canon.

   *This is the default preset — "Chronicle" — and the one the lineage requires.*
   Eight more ship alongside it, one per genre, because the palette should match
   what you are playing (`.design/TOKENS.md`). Each is pinned to a specific source
   inside its genre, since a genre name on its own is a mood and forbids nothing.
   All nine obey the rules below: one accent on a three-appearance budget, a second
   colour reserved for divergence, tinted neutrals, and no colour named in a
   component. A preset may change the hue; it may not change the discipline.
3. **Composition — the ruled column.** One measure per pane. The left edge is
   sacred: prose, composer and notes share it exactly. Folio numbers and status
   markers hang in the gutter as marginalia.
4. **Space — a 4px base.** Steps 4, 8, 12, 16, 24, 32, 48. Gaps between groups are
   always strictly larger than gaps within them.
5. **Shape — softened on purpose.** Radius grows with the element it wraps:
   2px on hairline meters, 5px on tags, 9px on controls, 16px on cards, 22px on the
   wizard. The object being borrowed from is a well-thumbed paperback and a hand of
   cards — both of which have rounded corners — not a guillotined ledger sheet.
6. **Depth — light, not shadow.** Dark ground, so elevation is carried by a
   lighter surface plus a 1px top-edge highlight plus a hairline rule. One material
   idea only: vellum grain at 3.5%. No black shadows anywhere.

## Five things this forbids

1. **No native form chrome.** No macOS blue slider, no default select chevron, no
   number spinner. Every control is drawn.
2. **No emoji, ever.** Marks are type or drawn glyphs.
3. **No centred text** except a genuinely modal empty state.
4. **No accent beyond three elements per view.** The gold is an indicator lamp,
   not a colour.
5. **No unbounded measure.** Prose and lists obey a measure; nothing stretches to
   1400px because the window is 1400px.

## The deliberate departures

Two, and only two.

The **graph view breaks the ruled column entirely** — it is a plate, bled to the
panel edge, with its own controls floating over it. A force-directed network has no
reading order, so imposing a column on it would be costume rather than structure.

The **rubricated initial breaks the sacred left edge**, once per scene, by hanging
out past the measure into the gutter. Everywhere else that edge is inviolable; this
is the one place it gives, and it gives exactly where a manuscript put its initial.

## Signature details

Four, each derived from the lineage rather than added on top:

- **The rubricated initial.** The first turn of every scene opens with a Big Caslon
  capital in the rubric colour, dropped two lines and hanging into the margin. It is
  the loudest thing in the book and it happens once per scene.
- **The mark.** A drawn nib, in the masthead, in the wizard, and on every scene
  break. One shape in three places is what makes a mark rather than a decoration.
  Drawn as SVG so it never depends on a font shipping the ornament, and it inherits
  `currentColor` so every preset tints it.
- **The folio marginal.** Every turn's scene·turn number hangs in the left gutter,
  the way a verse number sits in a psalter. Pinned turns take a rubric rule at the
  outer margin, where it reads as a bookmark tab.
- **The instrument scale.** Tension and budget are drawn as ruled scales with tick
  marks and a thin engraved marker, not as filled progress bars.
