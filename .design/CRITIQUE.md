# Fabulist — full design review

Judged from rendered screenshots at 1440×900, seeded world, four turns played.
Screens: `01`–`08` in this folder.

**Summary.** This is not a blank generated interface. It has real instincts: a warm
dark ground, an amber accent, and a three-register type split (serif = prose,
mono = machine, sans = chrome) that maps cleanly onto what the engine actually is.
The problem is that none of it is committed. The palette is undercommitted, the
hierarchy is inverted in two views, the accent is spent nine times a screen, and
three browser defaults are the loudest objects in the app. The work needed is
commitment, not replacement.

Ratings use `pass` / `minor` / `major`.

---

## 1. Visual hierarchy

### Entry point — `major`

**Observation.** On `book`, the eye lands first on the gold tension bars in the
sidebar, then on the grey monospace echo of the raw input, then — last — on the
prose. On `cast`, it lands on the column of seven identical `more` buttons and on
the bright white string `at loc:the-scriptorium · guarded`. On `threads`, it lands
on three 1000px-wide bright blue sliders.

**Problem.** The prose is the product. It never wins a single screen. On `threads`
the dominant element is an unstyled macOS form control — the entry point is
decided by the browser, not by the design.

**Fix.** Prose to 19px at a brighter ink. Kill all native control chrome. Demote
the raw echo to marginalia in the gutter. Make the name the largest object in a
name-first list.

### Eye flow — `major`

**Observation.** The book column is a 640px measure centred in its pane, so prose
begins at x=234. The composer and the "consequences set in motion" notes are
full-width and begin at x=12.

**Problem.** Three competing left edges in what is meant to be one column. The eye
jumps 220px left to write, and the notes about what just happened appear in a
third alignment, unrelated to both. The reading edge and the writing edge of the
same document do not line up.

**Fix.** One measure. Composer, notes and turns share the book's column and its
exact left edge.

### Weight — `major`

**Observation.** `.card h3` is styled as a small uppercase dim section label
(12px, `--dim`, uppercase). It is used for section labels — "WHY", "OPEN THREADS" —
*and* for proper names: character names in `cast`, entity names in the graph panel.
Beneath the name, the summary is 13px `--dim`; beneath that, the condition line is
13px full-strength `--ink`.

**Problem.** Hierarchy is inverted. In every cast card the character's name is the
smallest, dimmest text in the card, and the raw location slug is the brightest.
The size differential between "levels" is 12px→13px, or 1.08× — against a 1.5×
minimum. One CSS rule is doing two incompatible jobs.

**Fix.** Split the roles: `.eyebrow` for section labels, a real `.name` at 17px
serif in full ink for names. Demote metadata to `--dim`. This single change fixes
`cast` and the graph entity panel at once.

### Emphasis — `major`

**Observation.** `--accent` gold appears on: active tab underline, thread tension
bars, frame-budget bar, pinned-turn border, PLAYER tag, primary button, active
chips, focus rings, the spinner, and the largest graph node.

**Problem.** Nine-plus uses per view. An accent used everywhere is a second
neutral, so nothing is emphasised. Meanwhile the one element that should own it —
`play` — sits at `opacity: 0.45` for most of its life and reads as a muddy brown
smear.

**Fix.** Budget the accent at roughly three appearances per view: the primary
action, the active state, one point of emphasis. Tension bars and the budget bar
go neutral, taking accent only above a threshold where it means something.

---

## 2. Composition

### Balance — `major`

**Observation.** Every view is top-loaded. `threads` has 420px of empty canvas
below its content; `facts` has 600px; `graph`'s right rail has 740px; the `book`
sidebar has 300px.

**Problem.** No view has a centre of gravity. Content is simultaneously
over-compressed (a 300px fact column wrapping to two lines) and over-stretched
(a 1000px knower list) on the same row, with the whole composition floating at the
top of an empty field.

**Fix.** Give the tool views a real measure and let the column end. Fill the book
rail with the divergence ledger and scene context rather than leaving it void.

### Whitespace — `major`

**Observation.** Padding and margin values in use: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
11, 12, 13, 14, 16, 18, 20, 24, 26px.

**Problem.** Nineteen arbitrary values is not a spacing system. `9px`, `11px` and
`13px` recur with no rule behind them, so nothing aligns to anything and the
rhythm has to be re-decided at every component.

**Fix.** A 4px base with a fixed step set: 4, 8, 12, 16, 24, 32, 48. Every value
resolves to a token.

### Rhythm — `major`

**Observation.** `.card` has `padding: 12px` and `margin-bottom: 12px`.

**Problem.** The gap *between* cards is identical to the gap *inside* them, so by
proximity the cards do not read as separate groups — `cast` and `threads` become
one undifferentiated stack of rectangles at uniform weight.

**Fix.** Inside-gap strictly smaller than between-gap: 16px internal, 8px between
in a dense list, and let a hairline rule rather than a box carry the separation.

### Gestalt — `major`

**Observation.** `--bg` is `#14130f`, `--panel` is `#1c1a15` — a luminance ratio
of about 1.06:1. In `causality`, the status word ("fired", "pending") sits at the
far right of a 1080px row, roughly 1000px from the label it describes.

**Problem.** Figure/ground barely exists: cards do not read as cards, so the
containers do no grouping work. And the causality status is so far from its
subject that proximity cannot pair them — the eye has to traverse the row and
hold the label in memory.

**Fix.** Widen the surface separation and add a top-edge highlight so panels read
as raised. Bring status adjacent to its label as a tracked-caps marker.

---

## 3. Colour

### Palette coherence — `major`

**Observation.** `input[type="range"]` is unstyled, so macOS renders it in system
blue `#007AFF` with a white thumb. There are three of them on `threads` at 1000px
wide, plus five more on `settings`. `<select>` keeps its native chevron and
`<input type=number>` its native spinner.

**Problem.** Bright cool blue is the single loudest colour in an otherwise warm,
low-chroma amber interface, and it is not in the token system at all. It hijacks
the entry point of the `threads` view and breaks the palette on `settings`.

Separately, the graph's node palette (saturated yellow / blue / salmon / green /
violet) is a generic categorical ramp unrelated to the warm palette, and its five
hues sit at similar lightness — so they collapse into one grey in greyscale.

**Fix.** Style the range and select fully. Re-derive the graph ramp inside the
palette: hold the warm low chroma, move only hue, and separate the types by
lightness as well as hue so the encoding survives greyscale.

### Contrast — `major`

**Observation.** `--dimmer #6b6559` on `--bg #14130f` measures about **3.6:1**.

**Problem.** Below the 4.5:1 requirement for body text, and it is applied to
almost all metadata at 11–12px: the composer hint, the topbar meta, the graph
legend, every causality metadata line, the facts knower levels, the frame-budget
slot list. The smallest text in the app is also the least legible.

**Fix.** Raise the dimmest step to about 5.0:1 against the ground and reserve
anything lower for non-text decoration only.

### Semantic use — `minor`→`major`

**Observation.** `--ok` green means "vow held", "lint clean", "knows this fact",
and "consequence fired". `--warn` amber means "vow broken", "lint tripped",
"wrong belief", "ripening", and "unseen".

**Problem.** Four unrelated meanings per hue, so the colour stops carrying
meaning. In `facts`, `knows` vs `suspects` is encoded by name colour alone, with
the level word itself in near-invisible `--dimmer` — colour as sole indicator.

**Fix.** Keep the hue as a family but always pair it with a word or mark that
survives colour removal. Promote the level word to legible weight.

### Accessibility — `minor`

**Observation.** `--ok #7a9a6b` and `--warn #d08a3e` carry state on 2px left
borders in `causality`.

**Problem.** Warm-green against warm-orange is the standard deuteranopia
collision, and here it is expressed as a thin low-contrast border — the least
recoverable possible encoding.

**Fix.** Keep the border as reinforcement, carry the actual state in a tracked-caps
word.

---

## 4. Information density

### Cognitive load — `major`

**Observation.** `causality` renders 20 rows of near-identical monospace, in four
duplicate groups of the same five consequences, each row carrying
`d1 · offscreen-hidden · sig 0.25 · seeded s1 · after 2 scene(s)` at one uniform
weight.

**Problem.** Nothing is grouped, deduplicated or summarised, and no row is more
important than any other. The redaction bars for hidden items land at inconsistent
widths and read as broken loading skeletons rather than as deliberate redaction.

**Fix.** Group by scene with a count, lead each row with its status as a tracked
marker, and demote the metadata to a single dim line. Give the redaction a
deliberate hatched treatment so it reads as withheld, not broken.

### Content priority — `major`

**Observation.** In `facts`, the fact text column is about 300px and wraps to two
lines; the knower column runs to about 1000px.

**Problem.** The fact is the point of the row and gets the least space; the
supporting list gets the most, and wraps mid-name so "Sister Oria" and "knows"
land on different lines.

**Fix.** Give the fact the dominant column at a readable measure. Constrain and
delimit the knower list.

### Scanning — `major`

**Observation.** The knower list has no delimiters: `Brother Anselm knows Captain
Sered suspects Dural Vask suspects 0.3 Hela Vask knows …`.

**Problem.** It reads as one run-on string; name and state cannot be separated at
a glance.

**Fix.** One knower per row in a compact grid, name and state in different
registers, figures tabular.

### Progressive disclosure — `pass`

`cast`'s `more`/`less` and the causality spoiler toggle are both correct uses.

---

## 5. Generated-design tells present

Nine, from the `design-humanizer` catalogue:

1. **Emoji as icons** — `🔒`/`🔓` on the cast lock buttons. The strongest content tell.
2. **Native form chrome left as shipped** — range, select, number spinner.
3. **Radius with no logic** — 2, 3, 4, 6px scattered; 3px on buttons and inputs is a framework default.
4. **Absolutely flat** — no shadow, no grain, no texture anywhere in 253 lines of CSS. Zero material information.
5. **No light source** — no elevation model at all, so no surface reads as above another.
6. **One line-height for everything** — `font: 14px/1.5` globally.
7. **Proportional figures in numeric columns** — `127→45`, `1320→21` in the CALLS list and every `.mono` value; they jitter.
8. **Unchosen type** — `--serif` and the sans are pure system fallback chains; no face was selected.
9. **Untracked small caps** — mostly tracked, but `.tag` and `th` sit at `0.05em` where caps at 10–11px need more.

### Preserved deliberately

The three-register type split, the `why` transparency panel, the canon/chronicle
tag distinction, and the redaction-bar concept are all genuinely good ideas. They
are kept and strengthened rather than replaced.
