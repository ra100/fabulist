"""The marginalia set — the joke on purpose, on a dial.

Context. The first icon pass produced an accidental anatomical read and it was fixed
(see README.md). This is the opposite request: make it deliberate. That is a real
brief, and it has a real justification in this project's own lineage rather than
being a departure from it.

`.design/LINEAGE.md` picks the monastic chronicle, and puts folio numbers in the gutter
"as marginalia". Medieval manuscript marginalia are notorious for exactly this: bored
scribes drew obscene doodles in the margins of devotional books — phallus trees, bare
backsides, rude gestures — inches from the rubricated initial. So an indecent joke
hidden in the margin of a chronicle is not off-lineage. It is one of the most
historically authentic things this lineage could contain.

THE CRAFT POINT, which is the whole reason this can be done well rather than crudely:

    A double-reading mark must read as the innocent thing FIRST and COMPLETELY.

If the innocent reading is incomplete, it is not a joke — it is just a crude drawing
that also resembles a pen. Deniability is the mechanism, not a fig leaf: the viewer
has to see the nib, then see the other thing, and the gap between those two moments is
where the joke actually happens. Which means the barrel is load-bearing. It is the
single element that says "manufactured pen" unambiguously, so with the barrel attached,
every other property can be pushed back toward the second reading and the mark still
has somewhere innocent to land.

So the dial runs by re-enabling, one at a time, exactly the properties the fix removed:

    angle → upright · narrow → almond · plain slit → aperture + cleft

Restraint that is deliberate and worth keeping: this stays in gold on the Chronicle
ground. No flesh tones, no pink. The joke is FORMAL — a shape pun — and recolouring it
would turn it into a different and much worse joke, the kind with no second reading at
all. Same reason the cleft is never widened past what a real nib's slit could be.

    python3 .design/brand/marginalia.py
"""
import subprocess, os, re, sys
import build as B

C, S = B.C, B.S

# ---------------------------------------------------------------- the icon's gold
# The app's --accent is oklch(0.8 0.13 80) / #e9b452, and it is tuned for its job there:
# an indicator lamp on a three-appearance budget, so tiny areas. This icon makes the same
# colour the entire field, and chroma and lightness do not read the same at area — a light,
# low-chroma gold that is precise at 12px reads as pale butter at 400px.
#
# So the mark takes a deliberately different value, DERIVED from --accent rather than
# picked: same hue family (82 against 80), lightness down 7% and chroma up 11%. That is
# enough to read as gold leaf instead of butter, and small enough that the two are
# obviously relatives. Tested against the alternatives in render/_gold.png:
#
#     current   0.800 0.130 80  #e9b452   pale, chalky at area — the reported problem
#     SHIPPED   0.745 0.145 82  #daa223   reads as leaf; 8.6:1 on ground; holds at 16px
#     deeper    0.700 0.135 85  #c59720   handsome, antique, muddies at 16px
#     warmer    0.750 0.150 70  #e99b2a   too orange — collides with caution amber
#     cooler    0.770 0.130 94  #cfb246   brassy, drifts yellow-green against a warm ground
#     muted     0.780 0.100 80  #d9b06b   sand rather than gold; washy small
#     burnish   0.680 0.130 78  #c48d25   richest at 512, dimmest at 16 (6.4:1)
#
# This is legitimate only because the icon is already outside the token system — nine
# palette presets cannot share one favicon, so it never read --accent at runtime anyway.
# Revert by setting this to B.GOLD.
GOLD_ICON = '#daa223'   # oklch(0.745 0.145 82)


# ---------------------------------------------------------------- geometry
def almond(top, tip, hw, dome=0.94, sy_f=0.30):
    """A rounded-top vesica tapering to a point — the outline the fix removed.
    `dome` pushes the shoulder control points out; higher is rounder and fuller."""
    h = tip - top
    sy = top + h * sy_f
    return (f"M{C} {top} "
            f"C{C + hw * dome} {top + h * 0.07} {C + hw} {sy - h * 0.07} {C + hw} {sy} "
            f"C{C + hw} {sy + h * 0.34} {C + hw * 0.40} {tip - h * 0.20} {C} {tip} "
            f"C{C - hw * 0.40} {tip - h * 0.20} {C - hw} {sy + h * 0.34} {C - hw} {sy} "
            f"C{C - hw} {sy - h * 0.07} {C - hw * dome} {top + h * 0.07} {C} {top} Z")


def barrel(top, hw, length, join=30, taper=0.92, wf=0.50):
    """The holder. Drawn as its own shape behind the body, so the body keeps a full
    round dome instead of being flattened where the two meet.

    This is the deniability device and the reason the rest can be pushed. `wf` is its
    half-width as a fraction of the almond's — there is a floor on how small it can get
    before the map-pin read returns at the small sizes, measured in the study below.
    """
    w = hw * wf
    return (f"M{C - w} {top + join} L{C - w * taper} {top + join - length} "
            f"L{C + w * taper} {top + join - length} L{C + w} {top + join} Z")


def cleft(top, tip, r, w, y0f, y1f):
    """Aperture plus slit as one cut — a real nib's geometry, and also the half of
    the misread that the fix deleted. Here it is the point."""
    h = tip - top
    y0, y1 = top + h * y0f, top + h * y1f
    return (f"M{C - r} {y0} a{r} {r} 0 1 1 {r * 2} 0 "
            f"C{C + r} {y0 + h * 0.22} {C + 1.4} {y1 - h * 0.10} {C} {y1} "
            f"C{C - 1.4} {y1 - h * 0.10} {C - r} {y0 + h * 0.22} {C - r} {y0} Z")


def draw(top, tip, hw, dome, bar, ang, k, r, w, y0f, y1f):
    """Barrel behind, body in front, slit punched through."""
    b = barrel(top, hw, bar)
    body = almond(top, tip, hw, dome=dome)
    cl = cleft(top, tip, r, w, y0f, y1f)
    return (f'<g transform="rotate({ang} {C} {C}) '
            f'translate({C * (1 - k):.1f},{C * (1 - k):.1f}) scale({k})">'
            f'<path d="{b}" fill="{B.GOLD}"/>'
            f'<path d="{body} {cl}" fill="{B.GOLD}" fill-rule="evenodd"/></g>')


def flagged(**p):
    """The same mark with the app's own divergence marker beside it in the gutter.

    `--divergent` means "diverged from canon", and LINEAGE.md puts a rubric rule at
    the outer margin of a pinned turn "where it reads as a bookmark tab". So the
    chronicle has flagged this passage as non-canonical — which is the actual
    medieval marginalia gag: the scribe's rude doodle with a rubric note next to it.

    An earlier version of this variant painted the *slit* rubric instead. That was
    wrong on its own terms: it broke the formal-joke-only rule stated at the top of
    this file, the red pulled the eye straight into the cleft, and it was by far the
    least deniable of the set. The pun belongs outside the shape.
    """
    return (f'<path d="M110 122 V390" stroke="{B.RUBRIC}" stroke-width="5" '
            f'stroke-linecap="round"/>'
            f'<path d="M92 186 h36 v88 l-18 -17 -18 17 z" fill="{B.RUBRIC}"/>'
            + draw(**p))

def paragraph(x, y_mid, n, gap, sw, w, last=0.56, col=None):
    """A block of ruled prose — the page the doodle is scribbled beside.

    The stroke-to-gap ratio is what decides whether this reads as *text* or as a
    list icon. Widely spaced heavy rules are a hamburger menu; text wants the gap
    close to 1.8x the stroke, several lines, and a short ragged last line. The small
    per-line width variation is doing real work: perfectly equal rules read as a bar
    chart, and prose never sets flush on both edges by accident.
    """
    col = col or B.INK2
    jitter = (1.0, 0.95, 1.0, 0.93, 0.99, 0.96, 1.0, 0.94, 0.98)
    y0 = y_mid - (n - 1) * gap / 2
    out = []
    for i in range(n):
        ww = w * (last if i == n - 1 else jitter[i % len(jitter)])
        shade = col if i < n - 2 else B.INK3
        out.append(f'<path d="M{x} {y0 + i * gap:.1f} H{x + ww:.1f}" stroke="{shade}" '
                   f'stroke-width="{sw}" stroke-linecap="round"/>')
    return ''.join(out)


def page(top, tip, hw, dome, bar, k, r_ap, w, y0f, y1f, lamp=0.46, engraved=False,
         dx=-84, join=30, lines=10, gap=21, sw=12, pw=140, px=296, rule_x=274,
         bwf=0.40):
    """The doodle in the margin of a page — marginalia in its literal setting.

    Replaces the gauge crossing. The instrument scale was the panel half of the
    lineage; a block of ruled prose is the chronicle half, and it is the actual
    setting for this gag: medieval marginalia are rude drawings in the margin of a
    page of text, not annotations on a measuring rule. The composition is `rubric`'s
    — hero on the left, the measure ruled off to its right — so the two sit in the
    same family rather than each inventing a layout.

    The nib stays *inside* the margin rather than crossing the rule, which is the
    honest manuscript layout and keeps the two adjacent objects legible. `rubric`
    already owns the edge-breaking gesture in this family; a nib overlapping the rule
    by ten-odd pixels read as a bug rather than as a decision, and there is not room
    to make the crossing big enough to read as one.

    The lamp sits concentric inside the channel's aperture, leaving a ring of dark, so
    it reads as an indicator recessed in a slot rather than a mark above one. That is
    also what removed the exclamation mark: a detached dot above a tapering stroke is
    "!" at any size, and there is no detached dot here.

    A finding kept from the gauge version: **engraving reduces the anatomical read
    rather than emphasising it.** A bone contour makes the eye read the outline, and
    the dark interior recedes into the ground, where a solid gold mass reads as mass.
    Solid is the default because gold beside ink-coloured text is the manuscript
    reading; engraved is the tamer of the two.
    """
    h = tip - top
    body = almond(top, tip, hw, dome=dome)
    bar_d = barrel(top, hw, bar, join=join, wf=bwf)
    cut = cleft(top, tip, r_ap, w, y0f, y1f)
    ly, lr = top + h * y0f, r_ap * lamp
    off = C * (1 - k)

    if engraved:
        inner = (f'<path d="{bar_d}" fill="{B.SURF2}" stroke="{B.INK}" stroke-width="12"/>'
                 f'<path d="{body}" fill="{B.SURF2}" stroke="{B.INK}" stroke-width="12"/>'
                 f'<path d="{cut}" fill="{B.GROUND}" stroke="{B.INK2}" stroke-width="7"/>')
    else:
        inner = (f'<path d="{bar_d}" fill="{GOLD_ICON}"/>'
                 f'<path d="{body} {cut}" fill="{GOLD_ICON}" fill-rule="evenodd"/>')
    inner += f'<circle cx="{C}" cy="{ly:.1f}" r="{lr:.1f}" fill="{GOLD_ICON}"/>'

    rule = f'<path d="M{rule_x} 118 V394" stroke="{B.RULE2}" stroke-width="7"/>'
    return (f'{rule}{paragraph(px, C, lines, gap, sw, pw)}'
            f'<g transform="translate({dx},0) translate({off:.1f},{off:.1f}) '
            f'scale({k})">{inner}</g>')


# ---------------------------------------------------------------- the dial
# Each step re-enables one property the fix removed. Nothing else changes.
SET = [
    ('marginalia-1', 'plausible · 18°', draw,
     dict(top=150, tip=448, hw=98, dome=0.90, bar=96, ang=18, k=0.86,
          r=17, w=22, y0f=0.26, y1f=0.80)),
    ('marginalia-2', 'noticeable · upright', draw,
     dict(top=158, tip=452, hw=104, dome=0.94, bar=100, ang=0, k=0.88,
          r=19, w=24, y0f=0.26, y1f=0.80)),
    ('marginalia-3', 'not subtle · full almond', draw,
     dict(top=150, tip=456, hw=122, dome=1.00, bar=92, ang=0, k=0.90,
          r=23, w=28, y0f=0.25, y1f=0.80)),
    ('marginalia-flagged', 'rubric margin · diverged from canon', flagged,
     dict(top=158, tip=452, hw=98, dome=0.94, bar=100, ang=0, k=0.84,
          r=18, w=23, y0f=0.26, y1f=0.80)),
    ('marginalia-page', 'the doodle in the margin of a page', page,
     dict(top=158, tip=452, hw=118, dome=1.00, bar=58, k=0.68,
          r_ap=33, w=30, y0f=0.30, y1f=0.82, lamp=0.46)),
    ('marginalia-page-engraved', 'the same, engraved rather than filled', page,
     dict(top=158, tip=452, hw=118, dome=1.00, bar=58, k=0.68,
          r_ap=33, w=30, y0f=0.30, y1f=0.82, lamp=0.46, engraved=True)),
]


# ---------------------------------------------------------------- the quill tip
# A different proportion of the same construction: longer, thinner, with a longer taper —
# a cut quill rather than a fountain-pen nib. What actually distinguishes the two, and so
# what these numbers do:
#
#   * a quill is cut from a shaft, so the barrel is not a separate metal collar but the
#     feather continuing — near the body's own width (bwf 0.78) and longer
#   * the sides are straighter and converge over a long distance, so the dome is lower
#     (0.74) and the widest point sits high (sy_f 0.26) with a long taper below it
#   * the slit runs further down (y1f 0.88) and is narrower
#
# At 3.06:1 this reads as a pen nib and very little else, where the ~1:1.5 almond reads as
# a rounded bulb. It also holds better at 32px, because a distinctive silhouette survives
# downsampling where a blobby one does not.
#
# WORTH BEING EXPLICIT ABOUT: this proportion largely dissolves the marginalia reading. The
# almond at ~1:1.5 was one of the four properties driving it, and at 3:1 there is no almond
# left. So this is not a refinement of the joke version — it is a return to a straight nib,
# and it is a different decision rather than a tuning of the same one.
#
# It also resolves, from an angle the earlier study missed, the tension between a strong
# arrangement and a strong reading: a thin form survives the corner crop, because its taper
# stays legible even with the shaft cut, where the fat almond's collar was load-bearing.
QUILL_GEO = dict(top=126, tip=474, hw=70, dome=1.02, sy_f=0.26, belly=0.46, tipc=0.58,
                 bar=90, bwf=0.58, r_ap=22, w=19, y0f=0.26, y1f=0.88, join=26)


def quill_body(top, tip, hw, dome, sy_f, belly, tipc):
    """A nib's outline rather than almond()'s.

    almond() gives a lens whose sides converge in a near-straight run, which at 3:1 with a
    sharp point and a wide shaft reads as a DAGGER — handle, shoulder, blade. Reported on
    review and correct.

    A nib's sides are convex: they belly out past the shoulder and only turn in near the
    end, and the point is fine rather than needle-sharp because the tines flare. So this
    exposes `belly` (how far the taper holds its width) and `tipc` (how wide it still is
    approaching the point) as separate controls, and both are raised well above what a lens
    would use. Length is unchanged — length was never what made it a blade.
    """
    h = tip - top
    sy = top + h * sy_f
    return (f"M{C} {top} "
            f"C{C + hw * dome} {top + h * 0.07} {C + hw} {sy - h * 0.07} {C + hw} {sy} "
            f"C{C + hw} {sy + h * belly} {C + hw * tipc} {tip - h * 0.20} {C} {tip} "
            f"C{C - hw * tipc} {tip - h * 0.20} {C - hw} {sy + h * belly} {C - hw} {sy} "
            f"C{C - hw} {sy - h * 0.07} {C - hw * dome} {top + h * 0.07} {C} {top} Z")


def quill_art(fill=None, engraved=False, g=None):
    g = g or QUILL_GEO
    fill = fill or GOLD_ICON
    bar = barrel(g['top'], g['hw'], g['bar'], join=g['join'], wf=g['bwf'])
    body = quill_body(g['top'], g['tip'], g['hw'], g['dome'], g['sy_f'], g['belly'], g['tipc'])
    cut = cleft(g['top'], g['tip'], g['r_ap'], g['w'], g['y0f'], g['y1f'])
    if engraved:
        return (f'<path d="{bar}" fill="{B.SURF2}" stroke="{B.INK}" stroke-width="11"/>'
                f'<path d="{body}" fill="{B.SURF2}" stroke="{B.INK}" stroke-width="11"/>'
                f'<path d="{cut}" fill="{B.GROUND}" stroke="{B.INK2}" stroke-width="6"/>')
    return (f'<path d="{bar}" fill="{fill}"/>'
            f'<path d="{body} {cut}" fill="{fill}" fill-rule="evenodd"/>')


def quill_page(engraved=False, k=0.60, dx=-94, lines=10, gap=21, sw=12, pw=140,
               px=296, rule_x=274):
    """The quill tip in the master composition, so it is directly comparable."""
    off = C * (1 - k)
    jit = (1.0, 0.95, 1.0, 0.93, 0.99, 0.96, 1.0, 0.94, 0.98)
    y0 = C - (lines - 1) * gap / 2
    rules = ''.join(
        f'<path d="M{px} {y0 + i * gap:.1f} '
        f'H{px + pw * (0.56 if i == lines - 1 else jit[i % len(jit)]):.1f}" '
        f'stroke="{B.INK2 if i < lines - 2 else B.INK3}" stroke-width="{sw}" '
        f'stroke-linecap="round"/>' for i in range(lines))
    return B.tile(f'<path d="M{rule_x} 118 V394" stroke="{B.RULE2}" stroke-width="7"/>{rules}'
                  f'<g transform="translate({dx},0) translate({off:.1f},{off:.1f}) '
                  f'scale({k})">{quill_art(engraved=engraved)}</g>')


def quill_corner(k=2.05, shift=175, angle=-45):
    """The quill tip in the corner crop — thin enough that the taper survives the crop."""
    t = shift * 0.7071
    off = C * (1 - k)
    return B.tile(f'<g transform="translate({-t:.1f},{-t:.1f})">'
                  f'<g transform="rotate({angle} {C} {C}) translate({off:.1f},{off:.1f}) '
                  f'scale({k})">{quill_art()}</g></g>')


# ---------------------------------------------------------------- the corner crop
# A different composition of the same nib: rotated 45 degrees, anchored past the top-left
# corner, and left to be cropped by the tile, so about half of it is gone and the whole
# bottom-right diagonal is empty. The nib enters the frame and points into that void,
# which reads as the blank page it is about to write on.
#
# What it buys. This is the only composition here with real edge contact — everything else
# floats inside padding — so it is the only one whose arrangement reads as chosen. It also
# happens to neutralise BOTH earlier misreads at once: the map pin and the anatomical read
# each need a closed silhouette, and an open, cropped form is neither.
#
# What it costs, stated plainly. The barrel is the element that made the shape
# unmistakably a pen, and the barrel is exactly what the crop removes. At this crop the
# mark reads as a leaf or a petal about as readily as a nib. So this trades iconographic
# clarity for compositional strength — it becomes an abstract crop rather than a depicted
# object. That is a legitimate kind of mark, but it is a different decision from "a nib
# beside a page", not a refinement of it.
#
# Two findings from the study (render/_corner*.png):
#
#   * THE PAGE CANNOT BE ROTATED. Ruled lines read as text only while they are horizontal;
#     at 45 degrees they become hatching and the ruled edge becomes a stray diagonal. So
#     this composition works with the nib alone, and if it were adopted the icon and the
#     masthead lockup would diverge further than they do now.
#   * A LIGHT CROP IS WORSE THAN A HEAVY ONE. At about a third cut, a fragment of the
#     collar survives and reads as a nick bitten out of the outline — a bug, not a
#     decision. Removing it entirely is what makes the crop read as deliberate.
# Step 2 of the explicitness study (render/_push.png): proportion and cut widened one
# step from the original 1.9/150/hw118/cut33. That is as far as those levers go here —
# see the note below.
CORNER_K, CORNER_SHIFT = 2.05, 170
CORNER_HW, CORNER_DOME, CORNER_RAP, CORNER_W = 128, 1.06, 39, 35


def corner(k=CORNER_K, shift=CORNER_SHIFT, angle=-45, fill=None,
           hw=CORNER_HW, dome=CORNER_DOME, r_ap=CORNER_RAP, w=CORNER_W):
    """The nib rotated, oversized, and slid off the top-left corner along its own axis.

    THE CROP CAPS HOW FAR PROPORTION CAN BE PUSHED, which was not obvious until it was
    rendered as a four-step ramp (render/_push.png). Widening the almond and the cut one
    step reads as a mild increase. Past that it reverses: the cut grows until the dark
    becomes the figure and the gold is reduced to a frame around it, and the result is an
    abstract two-tone diagonal that reads as less of anything, not more of something.

    The reason is structural. The suggestive reading depended on a *closed* almond
    containing a cut, and the corner crop deliberately broke that silhouette open — which
    is exactly why the crop neutralised the map-pin and anatomical reads in the first
    place. So on this composition the two goals are in direct tension: what makes the
    arrangement strong is what limits how far it can be pushed. The upright uncropped
    form is the one those levers work on, and marginalia-3 is already the top of it.
    """
    fill = fill or GOLD_ICON
    g = dict(top=158, tip=452, hw=hw, dome=dome, bar=58, join=30,
             r_ap=r_ap, w=w, y0f=0.30, y1f=0.82, bwf=0.40)
    art = (f'<path d="{barrel(g["top"], g["hw"], g["bar"], join=g["join"], wf=g["bwf"])}" '
           f'fill="{fill}"/>'
           f'<path d="{almond(g["top"], g["tip"], g["hw"], dome=g["dome"])} '
           f'{cleft(g["top"], g["tip"], g["r_ap"], g["w"], g["y0f"], g["y1f"])}" '
           f'fill="{fill}" fill-rule="evenodd"/>')
    t = shift * 0.7071
    off = C * (1 - k)
    return B.tile(f'<g transform="translate({-t:.1f},{-t:.1f})">'
                  f'<g transform="rotate({angle} {C} {C}) translate({off:.1f},{off:.1f}) '
                  f'scale({k})">{art}</g></g>')


# ---------------------------------------------------------------- the small tier
# marginalia-page-engraved is the chosen mark. Measured against the pixel grid it holds
# every element down to 96px, goes borderline at 64 (the paragraph stops being text and
# becomes a grey block) and dies at 48. So it serves 512 / 180 / 96, and 48 and below get
# their own drawing.
#
# That drawing keeps the mark UPRIGHT and drops the paragraph and the barrel. An earlier
# attempt tilted a narrow nib 45 degrees instead; this is better, and the numbers say so.
# Fitted to the same 448 box:
#
#     upright, with barrel      scale 1.258   almond body 370
#     upright, no barrel        scale 1.524   almond body 448   (+21.1%)
#     45 degrees, with barrel   scale 1.544   almond body 454
#
# Removing the barrel buys the same space the rotation did — 448 against 454, inside
# 1.3% — so the tilt was paying for size with an orientation change it did not need to
# make. One mark, one orientation, at every size, and the barrel was the least useful
# thing at 16px anyway: it renders as a nub.
#
# It also fixed something the tilted version could not. The lamp was previously a
# large-size detail, because the ring of dark around it fell under one device pixel at
# 32px. With the barrel gone the almond scales up, the aperture grows with it, and the
# lamp now survives to 24px — which is what ties the small tier to the large one, since
# the lamp is the master's only colour.
#
# WHAT THIS COSTS, stated once and precisely. The barrel was the deniability device: the
# one element reading unambiguously as a manufactured pen. Without it, an upright,
# bilaterally symmetric almond with a central cleft has all four properties of the
# original accidental read and nothing suppressing any of them. There is no pen reading
# left to fall back on at 16px. That is the intended shape of this variant rather than a
# defect in it, but it means the small tier is the most explicit drawing in this
# directory, in the one place — a browser tab — where nobody opted in. `stub` below is
# the single knob that buys some cover back, at about 15% of the size.
# Measured by fitting real ink into a 448 box; re-measure if the collar changes.
SMALL_SCALE, SMALL_SCALE_STUB = 1.524, 1.39


def favicon(fill=None, widen=1.0, lamp=0.0, stub=58, bwf=0.40):
    """The <=48px drawing: upright, centred, no paragraph, no barrel.

    Solid rather than engraved: at this size a contour closes to a grey mass, and the
    engraved treatment additionally draws the cleft as an outlined enclosed region,
    which is both less legible and more explicit.

    THE COLLAR TURNS OUT TO BE STRUCTURAL, not decorative, and finding that took three
    renders. Removing it isolates the master's cut — a *keyhole*: a round aperture at the
    top of a tapering slit. Isolated and scaled up 21% by the barrel's absence, that
    aperture stops reading as a vent hole and becomes the head of a map pin, with the
    lamp inside it as the dot and the body around it as the ring. At 48px it is Google
    Maps' marker, and it cannot be tuned out: the cut was tried at 1.5x, 1.15x and 1.0x,
    and even at the master's own width the aperture is a bulge, and the bulge is the
    pin's head by construction.

    With the collar gone only two readings are available at all:

        narrow cut, no lamp   -> the anatomy, plainly
        keyhole cut + lamp    -> a map pin
        (collar restored)     -> a nib, and only then

    THE COLLAR HAS A FLOOR, measured rather than guessed. Shrinking it (length and width
    together) reads better — the almond dominates more and the whole mark gains grace —
    but only down to a point:

        bar 92 wf .50   chunky; the original
        bar 74 wf .44   smaller, still unmistakably a collar
        bar 58 wf .40   the floor: still a legible notch at 16px          <- shipped
        bar 44 wf .36   marginal at 16px
        bar 32 wf .32   gone at 16px, and the pin is back

    So the collar is back, and at the SAME LENGTH IN BOTH TIERS (58) rather than a stub. A
    mismatched collar caps the pin but leaves a silhouette matching nothing; sharing the
    master's value makes the small tier's outline *be* the master's outline, which is the
    whole point of a size-specific drawing being in the same family as the thing it
    reduces. It costs about 9% of scale against a collarless drawing.

    NO LAMP, and this is the part that only shows up in gold. Against the engraved
    master's bone contour a gold lamp is a real value and hue jump, so it read down to
    24px. Against the solid gold master it is gold inside a dark aperture inside a gold
    body — three rings, no contrast where it matters — and it reads as a hole with
    something in it rather than as a lamp. It is also redundant: the accent was a single
    lamp on the engraved version because the body was bone, and here the whole body is
    already the accent.
        """
    fill = fill or GOLD_ICON
    g = dict(top=158, tip=452, hw=118, dome=1.00, r_ap=33, w=30, y0f=0.30, y1f=0.82)
    h = g['tip'] - g['top']
    body = almond(g['top'], g['tip'], g['hw'], dome=g['dome'])
    cut = cleft(g['top'], g['tip'], g['r_ap'] * widen, g['w'] * widen, g['y0f'], g['y1f'])
    bits = ''
    if stub:
        bits += f'<path d="{barrel(g["top"], g["hw"], stub, join=30, wf=bwf)}" fill="{fill}"/>'
    bits += f'<path d="{body} {cut}" fill="{fill}" fill-rule="evenodd"/>'
    if lamp:
        bits += (f'<circle cx="{C}" cy="{g["top"] + h * g["y0f"]:.1f}" '
                 f'r="{g["r_ap"] * widen * lamp:.1f}" fill="{GOLD_ICON}"/>')
    k = SMALL_SCALE_STUB if stub else SMALL_SCALE
    off = C * (1 - k)
    return B.tile(f'<g transform="translate({off:.1f},{off:.1f}) scale({k})">{bits}</g>')



# ---------------------------------------------------------------- the app's mark
# web/src/Mark.tsx draws this same nib inline, at 13-14px, in the masthead, the wizard and
# every scene break. Its path is GENERATED here rather than redrawn there, so the mark in
# the app cannot drift from the mark on the icon:
#
#     python3 .design/brand/marginalia.py --mark
#
# The viewBox crops to the ink exactly (no padding), so the component controls its own
# size. At 13px the keyhole cut lands near one device pixel, so the cut is widened for the
# inline mark the same way the small tier widens it — same reason, different floor.
# The inline glyph follows the SHIPPED icon's shape family, which is now the quill nib
# (quill-corner is a crop of it). An abstract crop cannot be an inline glyph — it needs a
# frame to crop against and a masthead has none — so the glyph is the uncropped nib.
MARK_GEO = dict(QUILL_GEO)


def mark_paths(cut_widen=1.0):
    g = MARK_GEO
    body = quill_body(g['top'], g['tip'], g['hw'], g['dome'], g['sy_f'], g['belly'], g['tipc'])
    bar = barrel(g['top'], g['hw'], g['bar'], join=g['join'], wf=g['bwf'])
    cut = cleft(g['top'], g['tip'], g['r_ap'] * cut_widen, g['w'] * cut_widen,
                g['y0f'], g['y1f'])
    x0, y0 = C - g['hw'], g['top'] + g['join'] - g['bar']
    w, h = g['hw'] * 2, g['tip'] - y0
    # round the emitted numbers: the raw floats carry float noise that has no business
    # in a checked-in component
    tidy = lambda d: re.sub(r'-?\d+\.\d+', lambda m: f'{round(float(m.group()), 2):g}',
                            re.sub(r'(\d+)\.0(?=\D)', r'\1', d))
    return dict(body=tidy(body), barrel=tidy(bar), cut=tidy(cut),
                viewbox=f'{x0} {y0} {w} {h}', ratio=round(w / h, 4))


if __name__ == '__main__' and '--mark' in sys.argv:
    m = mark_paths()
    print(f'viewBox   {m["viewbox"]}')
    print(f'w/h ratio {m["ratio"]}')
    print(f'\nbarrel\n{m["barrel"]}')
    print(f'\nbody + cut (fill-rule evenodd)\n{m["body"]} {m["cut"]}')
    raise SystemExit


# ---------------------------------------------------------------- the header lockup
# The masthead wants the FULL mark — nib, ruled edge and page — not the nib alone, and it
# wants it taller than the text so it reads as a logo rather than as an inline glyph.
#
# It cannot be the master scaled down. A header gives about 30px of height, and the
# master's ten-line paragraph stops being text below 64px and becomes a grey slab
# (measured; see README.md). So this is a third tier with its own line count and weight,
# tuned so the page still reads as a page at masthead size:
#
#     python3 .design/brand/marginalia.py --header
#
# It also carries NO TILE. The master's dark ground and rounded corners are right for an
# app icon standing on its own; inside a bar that already has a surface they would be a
# box drawn inside a box. So the lockup is artwork only, on transparency, and the nib
# takes currentColor so the masthead rule keeps tinting it per preset.
HEADER_GEO = dict(top=158, tip=452, hw=118, dome=1.00, bar=58, join=30,
                  r_ap=33, w=30, y0f=0.30, y1f=0.82, bwf=0.40, k=0.68, dx=-84)


def header_lockup(lines=4, gap=46, sw=26, pw=150, px=300, rule_x=272, last=0.58):
    g = HEADER_GEO
    off = C * (1 - g['k'])
    tidy = lambda d: re.sub(r'-?\d+\.\d+', lambda m: f'{round(float(m.group()), 2):g}',
                            re.sub(r'(\d+)\.0(?=\D)', r'\1', d))
    bar_d = tidy(barrel(g['top'], g['hw'], g['bar'], join=g['join'], wf=g['bwf']))
    body_d = tidy(f'{almond(g["top"], g["tip"], g["hw"], dome=g["dome"])} '
                  f'{cleft(g["top"], g["tip"], g["r_ap"], g["w"], g["y0f"], g["y1f"])}')
    nib = dict(transform=f'translate({g["dx"]},0) translate({off:.1f},{off:.1f}) scale({g["k"]})',
               barrel=bar_d, body=body_d)
    jitter = (1.0, 0.94, 1.0, 0.96, 0.99)
    y0 = C - (lines - 1) * gap / 2
    rules = []
    for i in range(lines):
        ww = pw * (last if i == lines - 1 else jitter[i % len(jitter)])
        rules.append((round(y0 + i * gap, 1), round(ww, 1), i >= lines - 2))
    # ink bbox: nib left edge, paragraph right edge, rule top to nib tip
    x0 = (C - g['hw']) * g['k'] + off + g['dx']
    x1 = px + pw
    ytop = min(118.0, (g['top'] + g['join'] - g['bar']) * g['k'] + off)
    ybot = max(394.0, g['tip'] * g['k'] + off)
    return dict(nib=nib, rules=rules, rule_x=rule_x, px=px, sw=sw,
                viewbox=f'{x0:.1f} {ytop:.1f} {x1 - x0:.1f} {ybot - ytop:.1f}',
                ratio=round((x1 - x0) / (ybot - ytop), 4))


if __name__ == '__main__' and '--header' in sys.argv:
    h = header_lockup()
    print(f'viewBox   {h["viewbox"]}')
    print(f'w/h ratio {h["ratio"]}')
    print(f'rule_x    {h["rule_x"]}   stroke {h["sw"]}')
    print(f'\nnib group (fill=currentColor)\n{h["nib"]}')
    print('\nparagraph rules  (y, width, is_dim)')
    for r in h['rules']:
        print(f'  {r}')
    raise SystemExit

def main():
    """Guarded so this module can be imported for its geometry — _favicon.py
    reuses almond(), barrel() and cleft() and must not trigger a rewrite."""
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs('render', exist_ok=True)
    made = {}
    for name, _, fn, p in SET:
        made[name] = B.tile(fn(**p))
        open(f'icon-{name}.svg', 'w').write(made[name])
        print(f'icon-{name}.svg')

    # The ≤48px sibling of the chosen mark. marginalia-page (solid gold) is the pick, so
    # the small tier is gold with the master's own collar length and no lamp.
    fav = favicon()
    open('icon-marginalia-page-16.svg', 'w').write(fav)
    print('icon-marginalia-page-16.svg')

    # the quill tip — a longer, thinner proportion, not wired to anything
    for nm, svg in (('icon-quill-page.svg', quill_page()),
                    ('icon-quill-page-engraved.svg', quill_page(engraved=True)),
                    ('icon-quill-corner.svg', quill_corner())):
        open(nm, 'w').write(svg)
        print(nm)

    # the corner crop — an alternative composition, not wired to anything
    open('icon-marginalia-corner.svg', 'w').write(corner())
    print('icon-marginalia-corner.svg')

    # The engraved master's sibling, kept because that variant is still on the sheet and
    # its bone body is what lets a gold lamp read at this size.
    open('icon-marginalia-page-engraved-16.svg', 'w').write(favicon(fill=B.INK, lamp=0.40))
    print('icon-marginalia-page-engraved-16.svg')

    # The sheet leads with the shipped icon as the zero point, so the dial is legible as
    # a dial rather than as four unrelated drawings. It also runs each one down to 24px,
    # because the joke turns out to be size-gated — see README.md.
    ROW = [('nib (shipped · fixed)', 'the reference', open('icon-nib.svg').read())] + \
          [(n, note, made[n]) for n, note, _, _ in SET]
    SIZES = (512, 128, 48, 24)
    PAD, GAP, rowh = 30, 40, 512 + 92
    W = PAD * 2 + sum(SIZES) + GAP * (len(SIZES) - 1)
    H = PAD + rowh * len(ROW)
    sheet = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
             f'viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="#1a1714"/>']
    for r, (name, note, svg) in enumerate(ROW):
        y, x = PAD + r * rowh, PAD
        body = B.uniq(svg, f'm{r}')
        for sz in SIZES:
            sheet.append(f'<g transform="translate({x},{y + (512 - sz) // 2}) scale({sz / S})">{body}</g>')
            x += sz + GAP
        sheet.append(f'<text x="{PAD}" y="{y + 560}" font-family="monospace" font-size="30" '
                     f'fill="{B.INK3}">{name}</text>')
        sheet.append(f'<text x="{PAD}" y="{y + 596}" font-family="monospace" font-size="24" '
                     f'fill="{B.RULE2}">{note}</text>')
    sheet.append('</svg>')
    open('render/_marginalia.svg', 'w').write('\n'.join(sheet))
    subprocess.run(['inkscape', 'render/_marginalia.svg', '--export-type=png',
                    '--export-filename=render/_marginalia.png', '-w', '1200'], capture_output=True)
    print('render/_marginalia.png')

    # ---- the tier proof: each size drawn by whichever file actually serves it -----
    TIERS = [(512, 'master'), (180, 'master'), (96, 'master'),
             (48, 'favicon'), (32, 'favicon'), (16, 'favicon')]
    master = made['marginalia-page-engraved']
    PADT, GAPT = 30, 34
    W2 = PADT * 2 + sum(s for s, _ in TIERS) + GAPT * (len(TIERS) - 1)
    H2 = PADT * 2 + 512 + 60
    t = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W2}" height="{H2}" '
         f'viewBox="0 0 {W2} {H2}"><rect width="{W2}" height="{H2}" fill="#1a1714"/>']
    x = PADT
    for sz, which in TIERS:
        body = B.uniq(master if which == 'master' else fav, f't{sz}')
        t.append(f'<g transform="translate({x},{PADT + (512 - sz)}) scale({sz / S})">{body}</g>')
        t.append(f'<text x="{x}" y="{PADT + 512 + 34}" font-family="monospace" font-size="20" '
                 f'fill="{B.INK3}">{sz}</text>')
        t.append(f'<text x="{x}" y="{PADT + 512 + 58}" font-family="monospace" font-size="17" '
                 f'fill="{B.GOLD_M if which == "favicon" else B.RULE2}">{which}</text>')
        x += sz + GAPT
    t.append('</svg>')
    open('render/_tier-proof.svg', 'w').write('\n'.join(t))
    subprocess.run(['inkscape', 'render/_tier-proof.svg', '--export-type=png',
                    '--export-filename=render/_tier-proof.png', '-w', '1400'], capture_output=True)
    print('render/_tier-proof.png')


if __name__ == '__main__':
    main()
