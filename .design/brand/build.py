"""Fabulist app-icon drafts.

Six concepts on one 512 grid, each derived from something already written down in
.design/LINEAGE.md rather than added on top of it. Run:

    python3 .design/brand/build.py

Emits icon-<name>.svg per concept plus render/_sheet.png — the contact sheet at
512 / 96 / 48 / 32 / 16, because an app icon nobody has looked at at 16px has not
been designed.

Colour is the Chronicle preset (the default, and the one the lineage requires).
The values are the sRGB of the OKLCH in .design/palettes.mjs; an icon is a static
file and cannot read a CSS variable, so each is transcribed with its token name.

Two things were learned by rendering and looking, and both are load-bearing here:

  * A small round vent hole above a tapering slit reads as "!" at icon size. The
    hole and the slit are therefore one continuous channel, which is a real nib's
    geometry anyway and cannot come apart into two marks.
  * Icon linework has to be far heavier than UI linework. A 2px hairline is
    correct in the app at 48px of topbar; on a 512 tile that scales to nothing.
    Rules here sit at 8-16px, which is the same *optical* weight.
"""
import subprocess, os, re

# ---------------------------------------------------------------- tokens
GROUND = '#0c0a07'   # --ground
SURF1  = '#171310'   # --surface-1
SURF2  = '#201d18'   # --surface-2
RULE   = '#37322c'   # --rule
RULE2  = '#4d4740'   # --rule-strong
INK    = '#ede7de'   # --ink
INK2   = '#b0aaa0'   # --ink-2
INK3   = '#948d84'   # --ink-3
GOLD   = '#e9b452'   # --accent
GOLD_M = '#bd8f41'   # --accent-muted
RUBRIC = '#d6715e'   # --divergent  (means "diverged from canon")
CANON  = '#79a3cb'   # --canon

S, C = 512, 256          # canvas, centre
R_TILE = 112             # ~21.9% — the radius at which a square reads as an app tile


# ---------------------------------------------------------------- the nib
# Four properties stacked into an anatomical misread in the first version, caught on
# review: an upright, bilaterally symmetric vesica with a rounded aperture opening
# into a tapering central cleft. Adding that cleft in order to make the shape "read
# as a nib" is exactly what created it.
#
# Three of the four are now broken at once, because any one alone leaves the reading
# available:
#   * orientation — the nib is angled 32°, which is also how a nib is actually seen
#     in use, so the fix is the more accurate drawing rather than a compromise
#   * proportion — the body is ~1:4 rather than ~1:1.5, so there is no almond
#   * silhouette — the barrel is part of the same outline, which reads as a
#     manufactured pen and terminates the form at the top instead of closing it
#
# Symmetry is kept: with the other three broken it is doing no harm, and a
# three-quarter view (unequal half-widths) tested as more ornamental than clearer.
# A collar drawn as a separate slab reads as an acorn cap — it has to be continuous.
NIB_TOP, NIB_TIP, NIB_HW, NIB_BARREL = 196, 456, 72, 104
NIB_ANGLE = 32


def nib_outline(top=NIB_TOP, tip=NIB_TIP, hw=NIB_HW, barrel=NIB_BARREL, bw=0.62):
    """Nib body flowing into the barrel as one continuous outline."""
    h = tip - top
    sy = top + h * 0.30
    return (f"M{C - hw} {sy} "
            f"C{C - hw * 0.99} {sy - h * 0.14} {C - hw * 0.88} {top + h * 0.02} {C - hw * bw} {top} "
            f"L{C - hw * bw * 0.92} {top - barrel} "
            f"L{C + hw * bw * 0.92} {top - barrel} "
            f"L{C + hw * bw} {top} "
            f"C{C + hw * 0.88} {top + h * 0.02} {C + hw * 0.99} {sy - h * 0.14} {C + hw} {sy} "
            f"C{C + hw} {sy + h * 0.30} {C + hw * 0.40} {tip - h * 0.20} {C} {tip} "
            f"C{C - hw * 0.40} {tip - h * 0.20} {C - hw} {sy + h * 0.30} {C - hw} {sy} Z")


def nib_channel(top=NIB_TOP, tip=NIB_TIP, w=21, y0f=0.30, y1f=0.80):
    """The slit. Now a plain tapering channel: the round aperture that used to cap it
    was half of the misread, and the barrel already terminates the form up there."""
    h = tip - top
    y0, y1 = top + h * y0f, top + h * y1f
    return (f"M{C - w / 2} {y0} C{C - w / 2} {y0 + h * 0.20} {C - 1.2} {y1 - h * 0.10} {C} {y1} "
            f"C{C + 1.2} {y1 - h * 0.10} {C + w / 2} {y0 + h * 0.20} {C + w / 2} {y0} Z")


NIB = f'{nib_outline()} {nib_channel()}'


def nib_group(fill=GOLD, k=0.80, angle=NIB_ANGLE, dx=0, dy=0, d=None, extra=''):
    """The nib placed: rotated, scaled about the canvas centre, then nudged.
    Rotation is part of the mark, so every concept goes through here — including
    anything pinned to the nib, via `extra`, or it will not travel with it."""
    return (f'<g transform="rotate({angle} {C} {C}) translate({dx},{dy}) '
            f'translate({C * (1 - k):.1f},{C * (1 - k):.1f}) scale({k})">'
            f'<path d="{d or NIB}" fill="{fill}" fill-rule="evenodd"/>{extra}</g>')


# ---------------------------------------------------------------- type → path
def text_to_path(txt, family, size):
    """Convert real type to outlines via Inkscape, so no shipped SVG depends on a
    font being installed. Returns (d, x, y, w, h) of the resulting ink."""
    open('render/_t.svg', 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900">'
        f'<text x="120" y="700" font-family="{family}" font-size="{size}" fill="#000">{txt}</text></svg>')
    subprocess.run(['inkscape', 'render/_t.svg', '--export-text-to-path', '--export-plain-svg',
                    '-o', 'render/_t_out.svg'], capture_output=True)
    ds = re.findall(r'\sd="([^"]+)"', open('render/_t_out.svg').read())
    if not ds:
        raise SystemExit(f'no outline for {txt!r} in {family} — is the face installed?')
    d = ' '.join(ds)
    open('render/_m.svg', 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900">'
        f'<path d="{d}" fill="#000"/></svg>')
    q = subprocess.run(['inkscape', 'render/_m.svg', '--query-all'], capture_output=True, text=True)
    x, y, w, h = (float(v) for v in q.stdout.strip().split('\n')[1].split(',')[1:5])
    return d, x, y, w, h


def place(d, bx, by, bw, bh, cx, cy, target_h):
    """Scale an outline to target_h and centre its *ink* — not its box — on (cx, cy)."""
    k = target_h / bh
    return (f'<g transform="translate({cx - (bx + bw / 2) * k:.2f},{cy - (by + bh / 2) * k:.2f}) '
            f'scale({k:.5f})"><path d="{d}"/></g>')


# ---------------------------------------------------------------- tile chrome
GRAIN = ('<filter id="g" x="0" y="0" width="100%" height="100%">'
         '<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" '
         'stitchTiles="stitch"/></filter>')


def tile(inner, ground=GROUND):
    """Full-bleed ground, vellum grain at 3.5%, a top-edge highlight and a hairline
    inner rule. The lineage carries elevation with light, never with shadow."""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
            f'viewBox="0 0 {S} {S}" role="img" aria-label="Fabulist">'
            f'<defs>{GRAIN}<clipPath id="c"><rect width="{S}" height="{S}" rx="{R_TILE}"/></clipPath></defs>'
            f'<g clip-path="url(#c)">'
            f'<rect width="{S}" height="{S}" fill="{ground}"/>{inner}'
            f'<rect width="{S}" height="{S}" filter="url(#g)" opacity="0.035" '
            f'style="mix-blend-mode:overlay"/>'
            f'<path d="M{R_TILE * 0.45} 2.5 H{S - R_TILE * 0.45}" stroke="#fff" '
            f'stroke-opacity="0.10" stroke-width="5" fill="none"/>'
            f'<rect x="1.5" y="1.5" width="{S - 3}" height="{S - 3}" rx="{R_TILE - 1.5}" '
            f'fill="none" stroke="{RULE}" stroke-width="3"/>'
            f'</g></svg>')


# ---------------------------------------------------------------- 1 · nib
def c_nib():
    """The instrument, alone. Continuity with web/src/Mark.tsx, which already puts
    this shape in the masthead, the wizard and every scene break — so the icon is
    the mark the app already uses rather than a second, competing symbol."""
    return tile(nib_group(k=0.86))


# ---------------------------------------------------------------- 2 · rubric
def c_rubric():
    """The rubricated initial — the app's loudest signature detail, and the one
    place the sacred left edge is allowed to give. Big Caslon in the rubric colour,
    hanging past the ruled edge, with the measure ruled off to its right.

    The rules sit clear of the F's arm; when they touched it, the crossbar and the
    top rule read as one continuous stroke. The ruled edge runs past the initial
    top and bottom, so that what the initial is breaking is actually visible."""
    d, bx, by, bw, bh = text_to_path('F', 'Big Caslon', 400)
    rules = ''.join(
        f'<path d="M322 {190 + i * 44} H{322 + w}" stroke="{col}" stroke-width="14" '
        f'stroke-linecap="round"/>'
        for i, (w, col) in enumerate(((100, INK2), (100, INK3), (100, INK3), (62, GOLD_M))))
    return tile(
        f'<path d="M306 104 V416" stroke="{RULE2}" stroke-width="7"/>'    # the ruled edge
        f'<g fill="{RUBRIC}">{place(d, bx, by, bw, bh, 208, 256, 222)}</g>'  # …broken once
        f'{rules}')


# ---------------------------------------------------------------- 3 · strata
def c_strata():
    """The thesis, drawn: the prose is a view, the world is the graph underneath.

    The first attempt was a page above a network and read as a generic document-
    plus-org-chart, because nothing connected the two halves — which is the entire
    claim. Now one line descends from the middle rule into the hero node, so the
    drawing says the prose came *from* the structure rather than merely sitting
    above it. The satellites stay neutral: one accent, one appearance."""
    prose = ''.join(
        f'<path d="M152 {148 + i * 48} H{152 + w}" stroke="{col}" stroke-width="18" '
        f'stroke-linecap="round"/>'
        for i, (w, col) in enumerate(((208, INK), (208, INK2), (132, INK3))))
    n = [(168, 400), (256, 342), (344, 400)]
    edges = ''.join(f'<path d="M{n[a][0]} {n[a][1]} L{n[b][0]} {n[b][1]}" stroke="{RULE2}" '
                    f'stroke-width="9"/>' for a, b in ((0, 1), (1, 2), (0, 2)))
    return tile(f'{prose}'
                f'<path d="M256 262 V{n[1][1] - 26}" stroke="{GOLD_M}" stroke-width="7" '
                f'stroke-dasharray="14 13" stroke-linecap="round"/>'   # the view, derived
                f'{edges}'
                f'<circle cx="{n[0][0]}" cy="{n[0][1]}" r="20" fill="{INK3}"/>'
                f'<circle cx="{n[2][0]}" cy="{n[2][1]}" r="20" fill="{INK3}"/>'
                f'<circle cx="{n[1][0]}" cy="{n[1][1]}" r="28" fill="{GOLD}"/>')


# ---------------------------------------------------------------- 4 · gauge
def c_gauge():
    """The instrument panel. The nib rendered as engraved metal against a ruled
    scale, with a lamp at the shoulder — the lineage's 'exactly one amber indicator
    lamp', made literal instead of decorative.

    The scale is bracketed at both ends so it reads as measuring the nib rather than
    as ticks floating beside it. It stays vertical while the nib is angled: two
    different alignment systems in one frame is tension the panel can carry."""
    y0, y1 = 128, 452
    ticks = ''.join(
        f'<path d="M96 {y0 + i * (y1 - y0) / 8:.1f} h{34 if i % 2 == 0 else 19}" '
        f'stroke="{INK3 if i % 2 == 0 else RULE2}" stroke-width="{8 if i % 2 == 0 else 6}" '
        f'stroke-linecap="round"/>' for i in range(9))
    engraved = (f'<path d="{nib_outline()}" fill="{SURF2}" stroke="{INK}" stroke-width="12"/>'
                f'<path d="{nib_channel()}" fill="{GROUND}" stroke="{INK2}" stroke-width="7"/>')
    lamp = (f'<circle cx="{C}" cy="{NIB_TOP + (NIB_TIP - NIB_TOP) * 0.16:.0f}" r="17" '
            f'fill="{GOLD}"/>')
    return tile(
        f'<path d="M96 {y0} V{y1}" stroke="{RULE2}" stroke-width="7"/>{ticks}'
        f'<g transform="rotate({NIB_ANGLE} {C} {C}) translate(42,0) '
        f'translate({C * 0.26:.1f},{C * 0.26:.1f}) scale(0.74)">{engraved}{lamp}</g>')


# ---------------------------------------------------------------- 5 · folio
def c_folio():
    """The only asymmetric draft. The nib is pushed off-centre so that it crosses
    the ruled edge, counterweighted by the rubric bookmark tab — small, saturated
    and high-contrast against a large pale mass, which is how asymmetry resolves
    rather than just looking shoved.

    The nib being angled now does double duty: it crosses the ruled edge and runs
    against it, so the crossing reads without needing to be nudged."""
    return tile(
        f'<path d="M176 56 V456" stroke="{RULE2}" stroke-width="7"/>'
        f'<path d="M156 172 h40 v96 l-20 -18 -20 18 z" fill="{RUBRIC}"/>'   # the bookmark
        f'{nib_group(k=0.72, dx=58, dy=14)}')


# ---------------------------------------------------------------- 6 · seal
def c_seal():
    """A monastic seal crossed with an instrument dial. The ring gives the strongest
    silhouette of the six, which is what a favicon actually trades on.

    Two misreads were rendered and removed on the way here. Ticks *outside* the ring
    made it a brightness glyph — radiating strokes around a filled centre is that
    icon exactly. Turning them inward fixed that and produced a speedometer, because
    twelve evenly-spaced ticks over an open arc is *that* icon. Four ticks at the
    cardinals is a seal. The ring is cut only where the nib leaves it."""
    R = 172
    ticks = ''.join(
        f'<g transform="rotate({a} {C} {C})">'
        f'<path d="M{C} {C - R + 8} V{C - R + 42}" stroke="{INK3}" stroke-width="9" '
        f'stroke-linecap="round"/></g>' for a in (0, 90, 270))
    # closed but for a gap at the lower right, where the angled nib leaves the ring
    x0, y0 = C - R * 0.62, C + R * 0.78
    x1, y1 = C + R * 0.92, C + R * 0.39
    ring = (f'<path d="M{x0:.1f} {y0:.1f} A{R} {R} 0 1 1 {x1:.1f} {y1:.1f}" fill="none" '
            f'stroke="{RULE2}" stroke-width="9" stroke-linecap="round"/>')
    return tile(f'{ring}{ticks}{nib_group(k=0.62, dy=-4)}')


CONCEPTS = [('nib', c_nib), ('rubric', c_rubric), ('strata', c_strata),
            ('gauge', c_gauge), ('folio', c_folio), ('seal', c_seal)]


# ---------------------------------------------------------------- ≤20px variants
# A 512 drawing scaled to 16px is not a 16px icon. Below roughly 20px the channel
# closes, hairlines drop below one device pixel and any second element becomes
# grit. Each concept therefore gets a second drawing that keeps one idea and
# throws the rest away, on the same grid so the two are recognisably one mark.
def s_nib():
    """Wider body, wider channel, shorter barrel — every feature enlarged relative to
    the frame so it survives the pixel grid. Still angled: the misread the angle fixes
    gets *worse* small, not better, because detail is what distinguished the form."""
    d = (f'{nib_outline(top=210, tip=462, hw=96, barrel=74, bw=0.54)} '
         f'{nib_channel(top=210, tip=462, w=34, y0f=0.30, y1f=0.74)}')
    return tile(nib_group(k=0.94, d=d))


def s_rubric():
    """The initial alone. The measure cannot survive, so it goes."""
    d, bx, by, bw, bh = text_to_path('F', 'Big Caslon', 400)
    return tile(f'<g fill="{RUBRIC}">{place(d, bx, by, bw, bh, C, C, 300)}</g>')


def s_strata():
    """Two rules and the hero node — the claim reduced to its two halves."""
    return tile(
        f'<path d="M120 176 H392" stroke="{INK}" stroke-width="42" stroke-linecap="round"/>'
        f'<path d="M120 258 H310" stroke="{INK3}" stroke-width="42" stroke-linecap="round"/>'
        f'<circle cx="{C}" cy="378" r="62" fill="{GOLD}"/>')


def s_gauge():
    """Filled, not outlined: a 12px stroke closes to a grey mass at this size. Bone
    rather than mid-grey, because INK2 against the ground went muddy in the pixel
    test — engraved metal has to be light to read as metal. The lamp rides inside the
    rotated group; left outside it, it stayed upright while the nib turned."""
    body = nib_outline(top=210, tip=462, hw=96, barrel=74, bw=0.54)
    lamp = f'<circle cx="{C}" cy="248" r="34" fill="{GOLD}"/>'
    return tile(nib_group(fill=INK, k=0.94, d=body, extra=lamp))


def s_folio():
    """Rule and tab survive only as one heavy bar; the nib keeps its silhouette."""
    d = (f'{nib_outline(top=210, tip=462, hw=96, barrel=74, bw=0.54)} '
         f'{nib_channel(top=210, tip=462, w=34, y0f=0.30, y1f=0.74)}')
    return tile(
        f'<path d="M138 96 V416" stroke="{RUBRIC}" stroke-width="34" stroke-linecap="round"/>'
        f'{nib_group(k=0.82, dx=42, d=d)}')


def s_seal():
    """Ring thickened and closed; ticks dropped. The ring is the silhouette."""
    body = nib_outline(top=210, tip=462, hw=96, barrel=74, bw=0.54)
    return tile(
        f'<circle cx="{C}" cy="{C}" r="168" fill="none" stroke="{INK3}" stroke-width="30"/>'
        f'{nib_group(k=0.56, d=body)}')


SMALL = dict(nib=s_nib, rubric=s_rubric, strata=s_strata,
             gauge=s_gauge, folio=s_folio, seal=s_seal)

def uniq(body, tag):
    """SVG ids are document-scoped; a sheet inlines several of them into one file."""
    body = re.sub(r'^<svg[^>]*>', '', body).replace('</svg>', '')
    for a, b in (('id="g"', f'id="g{tag}"'), ('url(#g)', f'url(#g{tag})'),
                 ('id="c"', f'id="c{tag}"'), ('url(#c)', f'url(#c{tag})')):
        body = body.replace(a, b)
    return body


# ---------------------------------------------------------------- emit
def main():
    """Guarded so this module can be imported for its geometry and tokens —
    marginalia.py reuses tile(), nib_group() and the token block."""
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs('render', exist_ok=True)
    svgs, smalls = {}, {}
    for name, fn in CONCEPTS:
        svgs[name] = fn()
        open(f'icon-{name}.svg', 'w').write(svgs[name])
        smalls[name] = SMALL[name]()
        open(f'icon-{name}-16.svg', 'w').write(smalls[name])
        print(f'icon-{name}.svg  icon-{name}-16.svg')


    SIZES = (512, 96, 48, 32, 16)
    PAD, GAP = 28, 40
    rowh = 512 + 86
    # the last two columns re-run 20px and 16px through the size-specific drawing
    sheet_w = PAD * 2 + sum(SIZES) + GAP * (len(SIZES) - 1) + 130
    sheet_h = PAD + rowh * len(CONCEPTS) + 40
    sheet = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w}" height="{sheet_h}" '
             f'viewBox="0 0 {sheet_w} {sheet_h}"><rect width="{sheet_w}" height="{sheet_h}" fill="#1a1714"/>']
    hx = PAD
    for sz in SIZES:
        sheet.append(f'<text x="{hx}" y="{PAD - 4}" font-family="monospace" font-size="22" '
                     f'fill="{RULE2}">{sz}</text>')
        hx += sz + GAP
    sheet.append(f'<text x="{hx}" y="{PAD - 4}" font-family="monospace" font-size="22" '
                 f'fill="{GOLD_M}">32/16 small-size drawing</text>')
    for r, (name, _) in enumerate(CONCEPTS):
        y, x = PAD + 30 + r * rowh, PAD
        body, sbody = uniq(svgs[name], r), uniq(smalls[name], f's{r}')
        for sz in SIZES:
            sheet.append(f'<g transform="translate({x},{y + (512 - sz) // 2}) scale({sz / S})">{body}</g>')
            x += sz + GAP
        for sz in (32, 16):
            sheet.append(f'<g transform="translate({x},{y + (512 - sz) // 2}) scale({sz / S})">{sbody}</g>')
            x += sz + 26
        sheet.append(f'<text x="{PAD}" y="{y + 566}" font-family="monospace" font-size="30" '
                     f'fill="{INK3}">{name}</text>')
    sheet.append('</svg>')
    open('render/_sheet.svg', 'w').write('\n'.join(sheet))
    subprocess.run(['inkscape', 'render/_sheet.svg', '--export-type=png',
                    '--export-filename=render/_sheet.png', '-w', '1400'], capture_output=True)
    print('render/_sheet.png')


if __name__ == '__main__':
    main()
