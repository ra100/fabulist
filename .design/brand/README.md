# App icon — six drafts

Drafts, not a decision. Each is derived from something already written down in
`.design/LINEAGE.md` rather than added on top of it, and each is checked at real
pixel sizes rather than admired at 512.

```bash
python3 .design/brand/build.py       # the six drafts + render/_sheet.png
python3 .design/brand/marginalia.py  # the joke dial, the pick, its favicon tier
python3 .design/brand/marginalia.py --mark    # geometry for web/src/Mark.tsx
python3 .design/brand/marginalia.py --header  # geometry for web/src/MarkFull.tsx
python3 .design/brand/_pixels.py     # rasterises at 16/20/32 and magnifies the pixels
```

`build.py` is the source, and importable — `marginalia.py` reuses its tokens, tile
chrome and nib geometry. The SVGs are generated, so a proportion is changed by editing
a number rather than by nudging a path — the same reason `palettes.mjs` generates the
token blocks instead of the CSS being hand-kept.

## The six

| | Draft | Derived from | Reads at 16px |
| --- | --- | --- | --- |
| 1 | **nib** | The mark already in `web/src/Mark.tsx` | Diagonal gold sliver; holds |
| 2 | **rubric** | The rubricated initial, breaking the ruled edge | Best of the six — the F stays crisp |
| 3 | **strata** | "The prose is a view, the world is the graph underneath" | Poorly; the thesis does not survive |
| 4 | **gauge** | The instrument scale, one amber lamp | Weakest; the engraving closes up |
| 5 | **folio** | The folio marginal and the bookmark tab | Well — red bar plus gold nib |
| 6 | **seal** | Monastic seal × instrument dial | Strong; the ring is the silhouette |

Four of the six carry the nib. It is drawn **angled at 32°, narrow, with the barrel
part of the same outline** — see *What rendering them changed* for why all three of
those are non-negotiable.

**1 · nib** — The instrument alone. The argument for it is continuity: this shape is
already in the masthead, the wizard and every scene break, so the icon becomes the
mark the app *has* rather than a second symbol competing with it.

**2 · rubric** — Big Caslon `F` in red-oxide, hanging past the ruled edge with the
measure ruled off to its right. The most characterful of the six and, unexpectedly,
the most legible small. The cost: it drops the nib, so the app would carry two
unrelated marks unless `Mark.tsx` changes too.

**3 · strata** — The thesis drawn literally: a ruled page, and beneath it the
structure that generated it, with one dashed line descending into the hero node so
the page reads as *derived from* the graph rather than merely stacked above it.
Strongest idea, and the only one whose idea disappears entirely below ~32px.

**4 · gauge** — The nib as engraved metal against a bracketed scale, with the vent
hole as the single amber indicator lamp. The most faithful to the instrument half of
the lineage and the least legible small, because an 11px engraving line closes to a
grey mass.

**5 · folio** — The only asymmetric draft, and the best composition at 512: the nib
crosses the ruled edge off-centre, counterweighted by the rubric bookmark tab —
small, saturated and high-contrast against a large pale mass, which is how asymmetry
resolves instead of just looking shoved.

**6 · seal** — The nib inside a cut ring with ticks at the cardinals. The ring is the
strongest silhouette here, which is what a favicon actually trades on.

## What rendering them changed

Six drafts, six rebuilds. The things that only showed up in pixels:

- **The nib read as female anatomy.** Caught on review, not by me, and it is the most
  serious miss in this pass. Four properties stacked: an **upright**, **bilaterally
  symmetric** **vesica** with a rounded aperture opening into a **tapering central
  cleft**. The vesica piscis is the classical yonic symbol; I drew one and then cut a
  slit down the middle of it.

  Worse, I *introduced* it. The shape in pass 1 read as a leaf — harmless. Adding the
  cleft so it would "read as a nib" is exactly what created the problem, and the
  bone-white variant of `gauge` was arguably further along than the gold.

  Three of the four properties are now broken at once, because any one alone leaves
  the reading available:

  | Property | Fix | Note |
  | --- | --- | --- |
  | Upright | Angled 32° | Also the truer drawing — a nib in use is never seen face-on |
  | Almond, ~1:1.5 | Narrow body, ~1:4 | Removes the vesica outline entirely |
  | Cleft capped by a round aperture | Barrel integrated into the same outline | Terminates the form at the top instead of closing it |

  Symmetry is kept: with the other three broken it does no harm, and a three-quarter
  view (unequal half-widths) tested as more ornamental rather than clearer.

  Two things that did **not** work. A collar drawn as a separate slab above the body
  reads as an **acorn cap** — it has to be one continuous outline. And re-separating
  the vent hole into a small circle above the slit, safe again once the form was
  narrow and tilted, turned the nib into a **bird's head** with an eye.

- **A round vent hole above a tapering slit reads as `!`** at icon size — the misread
  that forced the merge in the first place, and in three of six drafts before anyone
  looked.
- **The slit is load-bearing.** A solid nib silhouette reads as a teardrop. Worth
  flagging against `Mark.tsx`, which went solid on the theory that the shoulder notch
  would carry it; at 13px in the masthead that is defensible, but the shape alone does
  not say *nib*. See the note below.
- **A dome plus a point is a map pin.** Superseded by the narrow angled body, but it
  is why the first three passes kept failing.
- **The nib's mass sits high.** Measured 19px above the canvas centre on a 512 grid
  while the body was upright. The angled version is placed by rotation instead, so
  the measurement no longer applies — recorded because it will apply again to any
  upright variant.
- **Icon linework is not UI linework.** A 2px hairline is right in the app at 48px of
  topbar; on a 512 tile it scales to nothing. Rules here run 6–18px, which is the same
  *optical* weight.
- **`seal` was a brightness glyph, then a speedometer.** Ticks outside a ring around a
  filled centre is the brightness icon exactly; turning them inward gave twelve even
  ticks over an open arc, which is the speedometer. Four ticks at the cardinals is a
  seal.
- **Anything pinned to the nib has to ride inside the rotation.** `gauge`'s lamp was
  drawn outside it once and stayed upright while the nib turned. Hence `nib_group`'s
  `extra` argument.
- **Every draft needs a second drawing below ~20px.** A 512 design scaled to 16px is
  not a 16px icon: the channel closes, hairlines fall under one device pixel and any
  second element becomes grit. Hence `icon-<name>-16.svg` — one idea kept, the rest
  discarded, on the same grid so the pair still reads as one mark.

### A note on `web/src/Mark.tsx`

The shipped mark is a symmetric upright vesica with no cleft. That is **not** the same
problem — without the cleft it reads as a leaf, which is why it has never been
remarked on — but it is two of the same four properties, and it is where the icon
started. If any nib draft here is adopted, `Mark.tsx` should be replaced with the same
angled geometry rather than left as a second, upright version of nearly the same
shape. That is a change to the masthead, the wizard and every scene break, so it is
worth deciding deliberately rather than as a side effect.

---

## The marginalia set — the joke on purpose

`marginalia.py`, six files, deliberately doing what the fix above undid. Asked for
after the accidental version was found, and it turns out to have a real justification
in this project's own lineage rather than being a departure from it.

`.design/LINEAGE.md` chooses the monastic chronicle and puts folio numbers in the
gutter *"as marginalia"*. Medieval manuscript marginalia are notorious for precisely
this: bored scribes drew obscene doodles in the margins of devotional books — phallus
trees, bare backsides, rude gestures — inches from the rubricated initial. An indecent
joke hidden in the margin of a chronicle is not off-lineage. It is one of the most
historically authentic things this lineage could contain.

### The craft principle

> A double-reading mark must read as the innocent thing **first and completely.**

If the innocent reading is incomplete, it is not a joke — it is a crude drawing that
also happens to resemble a pen. Deniability is the *mechanism*, not a fig leaf: the
viewer has to see the nib, then see the other thing, and the gap between those two
moments is where the joke happens.

Which makes **the barrel load-bearing**. It is the one element that says
"manufactured pen" unambiguously, so with it attached, every other property can be
pushed back toward the second reading and the mark still has somewhere innocent to
land. Remove the barrel and the whole set collapses into the accident from pass one.

The dial re-enables, one step at a time, exactly the three properties the fix removed:

| | Angle | Body | Slit | Reads as |
| --- | --- | --- | --- | --- |
| `nib` *(shipped)* | 32° | narrow ~1:4 | plain taper | a nib, and nothing else |
| `marginalia-1` | 18° | almond | aperture + cleft | a nib; the rest is available if you look |
| `marginalia-2` | upright | almond | aperture + cleft | a nib at a glance, then obviously not |
| `marginalia-3` | upright | full almond | wide aperture | not subtle, still technically a nib |
| `marginalia-flagged` | upright | almond | aperture + cleft | `-2` with the chronicle's own divergence marker beside it |
| `marginalia-page` | upright | full almond | channel + lamp inside it | the doodle in the margin of a page |
| `marginalia-page-engraved` | upright | full almond | channel + lamp inside it | the same, engraved |

`marginalia-flagged` puts the app's own `--divergent` rubric rule and bookmark tab in
the gutter — the marker `LINEAGE.md` gives a pinned turn "at the outer margin, where
it reads as a bookmark tab". The chronicle has flagged this passage as non-canonical,
which is the actual medieval gag: the scribe's rude doodle with a rubric note next to
it.

### The page crossing

`marginalia-page` puts `marginalia-3`'s geometry beside a block of ruled prose. It
replaces an earlier crossing with `gauge`, and the swap is the better idea: the
instrument scale was the *panel* half of the lineage, where a paragraph is the
*chronicle* half — and the chronicle half is the actual setting for this gag. Medieval
marginalia are rude drawings in the margin of a page of text, not annotations on a
measuring rule. The composition is deliberately `rubric`'s — hero left, measure ruled
off to the right — so the two sit in one family instead of each inventing a layout.

The lamp sits **concentric inside the channel's aperture**, leaving a ring of dark
around it, so it reads as an indicator recessed in a slot rather than as a separate
mark above one. That placement is what removed the exclamation mark: a detached dot
above a tapering stroke is `!` at any size, and there is no detached dot here — one
cut, one lamp inside it. An earlier version floated the dot above the slit and read as
an outlined shield containing `!`, which is the universal security-warning glyph.

Four findings, one of them a correction of my own reasoning:

- **Engraving *reduces* the anatomical read rather than emphasising it.** I predicted
  the opposite in the code, on the reasoning that outlining turns the channel into an
  enclosed drawn region rather than an absence. Wrong: a bone contour makes the eye
  read the **outline**, and the dark interior recedes into the ground, where a solid
  gold mass reads as mass. Identical geometry, and the engraved version is markedly
  tamer. Rendering settled it; reasoning had it backwards. Solid is the default anyway,
  because gold beside ink-coloured text is the manuscript reading and it gives the
  better hierarchy — bone nib against grey rules puts the two at the same value.
- **Stroke-to-gap ratio is what separates *text* from a list icon.** Widely spaced
  heavy rules are a hamburger menu. A paragraph wants a gap near 1.8× the stroke, ten
  or so lines, and a short ragged last line. The small per-line width variation earns
  its keep too: perfectly equal rules read as a bar chart, and prose never sets flush
  on both edges by accident.
- **The lamp is a large-size detail and cannot be tuned to survive small.** Not a
  defect — geometry. At 32px the dark ring between lamp and body is under one device
  pixel, so it aliases away. Holding a two-pixel ring at 32px would need an aperture of
  ~55 units, wider than the nib can carry. It degrades gracefully — the lamp merges and
  leaves a plain channel — so the honest statement is that this crossing is designed
  for 48px and up.
- **The nib stays inside the margin rather than crossing the rule.** `rubric` already
  owns the edge-breaking gesture in this family, and there is not room here to make a
  crossing big enough to read as deliberate; at ten-odd pixels it read as a bug. Two
  adjacent objects with a clean gutter is also the honest manuscript layout.

### Chosen: `marginalia-page`, in four tiers

Picked on review. It ships as **two drawings, not one**, because the master does not
reduce — measured against the pixel grid rather than guessed:

| Size | Drawing | Why |
| --- | --- | --- |
| 512 | `icon-marginalia-page.svg` | everything reads |
| 180 | the same | everything reads |
| 96 | the same | the floor — the paragraph is still text |
| ≤48 | `icon-marginalia-page-16.svg` | at 64 the paragraph stops being text and becomes a grey block; at 48 it is a grey slab |

The small tier keeps the mark **upright and centred**, drops the paragraph and the ruled
edge, and is otherwise the master's nib verbatim: same gold, same collar length, same
keyhole cut. `render/_family.png` puts the two rows together — the small drawing is the
master's nib isolated and scaled up, not a new shape.

**An earlier attempt tilted a narrow nib 45° instead. Upright is better, and measurement
says so rather than taste.** Fitted to the same 448 box:

| | Scale that fits | Almond body |
| --- | --- | --- |
| upright, with collar | 1.258 | 370 |
| upright, no collar | 1.524 | 448 *(+21.1%)* |
| 45°, with collar | 1.544 | 454 |

Dropping the collar buys the same space the rotation did — 448 against 454, inside 1.3%
— so the tilt was paying for size with an orientation change it never needed to make.
One mark, one orientation, every size.

**But the collar cannot go, and finding that took three renders.** Removing it isolates
the master's cut, which is a *keyhole*: a round aperture at the top of a tapering slit.
Isolated, and scaled up 21% by the collar's absence, that aperture stops reading as a
vent hole and becomes **the head of a map pin** — the body around it as the ring. At 48px
it is Google Maps' marker, and it cannot be tuned out: the cut was tried at 1.5×, 1.15×
and 1.0×, and even at the master's own width the aperture is a bulge and the bulge is the
pin's head by construction. With the collar gone only two readings are available at all:

| Cut | Reads as |
| --- | --- |
| narrow, no lamp | the anatomy, plainly |
| keyhole + lamp | a map pin |
| *collar restored* | a nib — and only then |

So the collar is back at the **master's own length**, not as a stub. A short collar caps
the pin but leaves a silhouette matching nothing; at full length the small tier's outline
*is* the master's outline, which is the entire point of a size-specific drawing. It costs
about 17% of scale against a collarless one, and that is the price of the match.

**No lamp, and this only shows up in gold.** Against the *engraved* master's bone contour
a gold lamp is a real value and hue jump, so it read down to 24px — which is why the
engraved sibling keeps it. Against the *solid gold* master it is gold inside a dark
aperture inside a gold body: three rings with no contrast where it matters, reading as a
hole with something in it rather than as a lamp. It is also redundant, since the accent
was a single lamp on the engraved version precisely because the body was bone, and here
the whole body is already the accent. The master keeps its lamp — at 512 it reads — and
the small tier drops it, which costs nothing because it never read at that size anyway.

`icon-marginalia-page-engraved-16.svg` is still emitted for the engraved variant, in
bone with the lamp, since that pairing is the one where a lamp works.

### A third tier: the masthead lockup

`web/src/MarkFull.tsx` is the mark in the app header — the whole lockup, nib and ruled
edge and page, standing taller than the 18px title (30px, 1.67×) so it reads as a logo
rather than as an ornament beside a word.

It is a **third drawing**, not the master scaled down, for the same reason the small tier
exists: a masthead gives about 30px, and the master's ten-line paragraph stops being text
below 64px. Line counts were rendered at 24/28/32/40px before choosing
(`render/_headerlockup.png`):

| | At 24–28px |
| --- | --- |
| 10 lines, master weight | a grey slab with faint striping |
| 5 lines, gap 38, stroke 22 | reads |
| **4 lines, gap 46, stroke 26** | **reads clearly, and the short last line still says *paragraph*** |
| 3 lines, gap 58, stroke 32 | chunky, and reads as a list rather than prose |

Two deliberate differences from the icon:

- **No tile.** The dark ground and rounded corners are right for a file standing on its
  own; inside a bar that already has a surface they are a box drawn inside a box.
- **The nib takes `currentColor`, the page and rule take tokens.** So the nib follows the
  palette preset exactly as the inline mark does, and no colour is named in the component.
  The consequence, which is correct rather than a bug: under a non-Chronicle preset the
  masthead nib and the browser tab will not match, because the icon is a static file with
  a fixed colour and the app mark follows the picker.

`Mark.tsx` remains the glyph — the nib alone, set inline at cap height — and still serves
the wizard and every scene break. Its geometry is generated from the same source
(`--mark`), so glyph, lockup and icon cannot drift apart.

### The gold is the icon's, not the app's

`--accent` is `oklch(0.8 0.13 80)` / `#e9b452`, and it is right for its job in the app: an
indicator lamp on a three-appearance budget, so tiny areas. **This icon makes the same
colour the entire field**, and chroma and lightness do not read the same at area — a
light, low-chroma gold that is precise at 12px reads as pale butter at 400px, which is
exactly the complaint that prompted this.

So the mark takes a different value, **derived from `--accent` rather than picked**: same
hue family (82 against 80), lightness down 7%, chroma up 11%.

```
--accent      oklch(0.800 0.130 80)  #e9b452   pale, chalky at area
GOLD_ICON     oklch(0.745 0.145 82)  #daa223   reads as leaf · 8.6:1 on ground · holds at 16px
```

Rejected, all rendered at size in `render/_gold.png` rather than judged as swatches:

| | | Why not |
| --- | --- | --- |
| `0.700 0.135 85` | `#c59720` | handsome and antique, but muddies at 16px |
| `0.750 0.150 70` | `#e99b2a` | too orange — collides with caution amber |
| `0.770 0.130 94` | `#cfb246` | brassy, drifts yellow-green against a warm ground |
| `0.780 0.100 80` | `#d9b06b` | sand rather than gold; washy small |
| `0.680 0.130 78` | `#c48d25` | richest at 512, dimmest at 16 (6.4:1) |

Two of the first drafts of that list clipped sRGB at high chroma in the orange-yellow
region, which is the same trap `palettes.mjs` guards against; chroma was pulled back until
they were in gamut before any of them were looked at.

**This divergence is legitimate only because the icon was already outside the token
system** — nine palette presets cannot share one favicon, so the file never read
`--accent` at runtime anyway. It is one constant, `GOLD_ICON` in `marginalia.py`; setting
it to `B.GOLD` reverts. `render/_gold-ab.png` is the before/after.

The gold is identical at every tier. Two things still cannot be: the master's grey
paragraph has nowhere to go below 96px, and its lamp stops reading below about 32px. The
lamp could be carried down for structural parity — it would simply merge into the body and
cost nothing — but it would be an element that does nothing visible, so it is left out
until asked for.

### Restraint that is deliberate

This stays **gold on the Chronicle ground**. No flesh tones, no pink. The joke is
*formal* — a shape pun — and recolouring it makes it a different and much worse joke,
the kind with no second reading at all. The cleft is also never widened past what a
real nib's slit could plausibly be.

That rule was tested by breaking it. An earlier `marginalia-rubric` painted the *slit*
red-oxide as the punchline for "diverged from canon". Clever on paper, wrong in
pixels: it violated the formal-only rule stated one paragraph up, the red pulled the
eye straight into the cleft, and it was by far the least deniable of the set. The pun
belongs outside the shape, which is what `-flagged` does instead.

### Deniability gets *worse* small, not better

The assumption going in was that the joke would be size-gated — visible on a README
at 512, harmless in a 16px browser tab. **That is wrong**, and `render/_dial-pixels.png`
shows it: `marginalia-2` and `-3` read as the joke more clearly at 24px than at 512.

The reason is straightforward once seen. Downsampling destroys the *pen* information
first — barrel proportion, shoulder, taper, the 18° tilt — because those are fine and
peripheral. The slit is high-contrast, central and large, so it is the last thing
standing. Strip the deniability and leave the punchline: the mark gets **less**
innocent as it gets smaller.

Practical consequence: there is no version of this that is safe as a favicon on the
grounds that nobody will see it at that size. They will see it more.

### Recommendation

`marginalia-page` is the pick (see the tier section above). If you would rather
keep the joke off the front door, ship `nib` and hold a marginalia variant as an **easter
egg** — an alternate behind a setting, an April build, a sticker, the 404 page. `-1` is
the only one I would put where a stranger meets it unwarned; `-2` is the sweet spot if
the joke is meant to land; `-3` has no deniability left and shows where the dial ends.

Worth saying plainly, since a pick has now been made: an app-store listing, a work README
or a screenshot in a bug report is a context where the reader did not opt in, and this is
a fiction engine people may well run on a work laptop. The engraved treatment and the
45° small tier both pull hard in the safer direction — engraving reads as a technical
drawing, and rotation is the strongest suppressor there is — but they mitigate rather
than remove. That is a product call, not a design one.

## Files

`icon-<name>.svg` is the 512 master; `icon-<name>-16.svg` is the ≤20px drawing.
`icon-marginalia-*.svg` are the joke set (`-page-engraved` plus its `-16` sibling is the pick) and are referenced by nothing. All are ~1–2 KB,
valid standalone SVG, and carry no font dependency — the Big Caslon `F` is outlined at
build time, so nothing depends on the face being installed.

Colour is the **Chronicle** preset, transcribed from the OKLCH in
`.design/palettes.mjs` with each token name kept beside its value. An icon is a
static file and cannot read a CSS variable, so this is the one place a colour is
written down outside the generated token blocks. It does not follow the palette
picker: nine presets cannot share one favicon, and Chronicle is the default and the
one the lineage requires.

Each tile carries the lineage's depth rule rather than a shadow — a lighter ground,
vellum grain at 3.5%, a top-edge highlight and a hairline inner rule. Corner radius
is 112 (21.9%), which approximates the iOS squircle so the tile reads as an app icon
where no OS mask is applied, and clips harmlessly where one is.

## Not done yet

- **Nothing is wired up.** `web/index.html` has no `<link rel="icon">` and there is no
  `web/public/`. With a pick now made, wiring it is: `favicon.svg` pointing at the ≤48
  drawing, `apple-touch-icon.png` rasterised from the master at 180, and a manifest pair
  at 192/512 — the 192 needs its own decision, since it falls between the two tiers.
  Say the word and I will do it.
- **`web/src/Mark.tsx` is unchanged** and still carries the upright shape. See the note
  above — it should follow whichever draft is adopted.
- **No `.icns` / `.ico` / maskable PWA variants.** An Android maskable icon needs a
  20% safe margin, which the tiles do not currently reserve.
- **`gauge` and `strata` need more work than the other four** if either is chosen —
  both are legible statements at 512 that fall apart small, and both would need a
  more radical small-size drawing than the one shipped here.
- **The misread was caught by a human, not by me.** Every check in this directory is
  a *legibility* check: does it read at 16px, does the hierarchy hold, does the
  contrast pass. Nothing here tests for unintended resemblance, and the four
  misreads found in this pass (`!`, map pin, brightness, speedometer) were all found
  by chance. Fresh eyes on a contact sheet remain the only method that worked.
