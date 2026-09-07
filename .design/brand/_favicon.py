"""Favicon drawing for marginalia-page-engraved.

Two questions, both answered by measuring rather than asserting:

1. Does a 45° tilt actually buy space? The intuition is that the square's diagonal
   is longer than its side, so a tilted object can be bigger. That is true only for
   objects much thinner than they are long — the rotated bounding box grows in *both*
   axes, so a stubby object pays a width penalty that eats the diagonal gain. This nib
   with its barrel is about 1.5:1, which is near the break-even, so it needs measuring.

2. Gold or bone? The engraved master's dominant impression is its bone contour, not
   the gold lamp, so continuity argues for bone; the rest of the icon family is gold.

Both are settled below by rasterising and looking, not by reasoning.
"""
import subprocess, os, re
import build as B

C, S = B.C, B.S
import marginalia as M          # almond / barrel / cleft, and the chosen proportions

# The chosen master's geometry, verbatim, so the favicon is the same mark.
GEO = dict(top=158, tip=452, hw=118, dome=1.00, bar=92, r_ap=33, w=30,
           y0f=0.30, y1f=0.82, join=30)


def quill(scale, angle, fill, widen=1.0, lamp=0.0, geo=GEO):
    """Just the nib: no paragraph, no rule, solid rather than engraved.

    Solid because a 12px contour closes to a grey mass below ~40px — established when
    the same problem hit `gauge`. The lamp is off by default because the ring of dark
    around it falls under one device pixel at 32px and it merges into the body.
    """
    body = M.almond(geo['top'], geo['tip'], geo['hw'], dome=geo['dome'])
    bar = M.barrel(geo['top'], geo['hw'], geo['bar'], join=geo['join'])
    cut = M.cleft(geo['top'], geo['tip'], geo['r_ap'] * widen,
                  geo['w'] * widen, geo['y0f'], geo['y1f'])
    d = f'{body} {cut}'
    inner = f'<path d="{bar}" fill="{fill}"/><path d="{d}" fill="{fill}" fill-rule="evenodd"/>'
    if lamp:
        h = geo['tip'] - geo['top']
        inner += (f'<circle cx="{C}" cy="{geo["top"] + h * geo["y0f"]:.1f}" '
                  f'r="{geo["r_ap"] * widen * lamp:.1f}" fill="{B.GOLD}"/>')
    off = C * (1 - scale)
    return (f'<g transform="rotate({angle} {C} {C}) translate({off:.1f},{off:.1f}) '
            f'scale({scale})">{inner}</g>')


def ink_extent(markup):
    """Longest dimension of the actual ink, via Inkscape's own bbox query."""
    open('render/_q.svg', 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" '
        f'viewBox="0 0 {S} {S}">{markup}</svg>')
    q = subprocess.run(['inkscape', 'render/_q.svg', '--query-all'],
                       capture_output=True, text=True)
    xs, ys, xe, ye = [], [], [], []
    for line in q.stdout.strip().split('\n'):
        p = line.split(',')
        if len(p) >= 5:
            try:
                x, y, w, h = (float(v) for v in p[1:5])
            except ValueError:
                continue
            xs.append(x); ys.append(y); xe.append(x + w); ye.append(y + h)
    if not xs:
        return 0, 0, 0
    bw, bh = max(xe) - min(xs), max(ye) - min(ys)
    return bw, bh, max(bw, bh)


def main():
    """Guarded: this module is imported for ink_extent(), which is the measurement
    behind the 45-degree-versus-upright numbers in README.md. Importing it must not
    re-run the study or rewrite render/."""
    # ---------------------------------------------------------------- 1 · the space claim
    # Fit each angle to the same 448 box (a favicon may bleed closer than the 384 live
    # area, since no OS mask applies to a browser tab) and report the ink actually got.
    #
    # Measured once per angle rather than bisected: the transform scales about the centre
    # before rotating, so ink extent is linear in the scale factor and the largest fitting
    # scale is just FIT / extent-at-1. Measuring real ink rather than the bounding
    # rectangle matters here — the nib is pointed at the tip and narrow at the barrel, so
    # its rotated ink is meaningfully smaller than a rotated w×h box would predict, which
    # is the whole question.
    FIT = 448
    NIB_LEN = GEO['tip'] - (GEO['top'] + GEO['join'] - GEO['bar'])
    print(f'unrotated nib: {2 * GEO["hw"]} wide × {NIB_LEN} long  ({NIB_LEN / (2 * GEO["hw"]):.2f}:1)')
    print('angle   scale   ink w×h       longest   nib length on canvas')
    best = {}
    for ang in (0, 22, 32, 45):
        bw, bh, longest = ink_extent(quill(1.0, ang, B.GOLD))
        k = FIT / longest
        best[ang] = k
        print(f'{ang:3d}°   {k:.3f}   {bw * k:5.0f}×{bh * k:5.0f}    {longest * k:5.0f}     {NIB_LEN * k:5.0f}')
    gain = (NIB_LEN * best[45]) / (NIB_LEN * best[0]) - 1
    print(f'45° vs upright: {gain * +100:+.1f}% object length')

    # ---------------------------------------------------------------- 2 · look at it
    VARIANTS = [
        ('upright · gold', 0, B.GOLD, 1.20),
        ('32° · gold', 32, B.GOLD, 1.20),
        ('45° · gold', 45, B.GOLD, 1.20),
        ('45° · bone', 45, B.INK, 1.20),
        ('45° · bone · wider cut', 45, B.INK, 1.55),
        ('45° · bone · lamp', 45, B.INK, 1.55),
    ]
    SIZES = (64, 32, 24, 16)
    Z, PADL, GAPX = 7, 250, 20
    rowh = max(SIZES) * Z + 30
    blockw = sum(s * Z for s in SIZES) + GAPX * (len(SIZES) - 1)
    W, H = PADL + blockw + 40, 60 + rowh * len(VARIANTS)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="#1a1714"/>']
    x = PADL
    for s in SIZES:
        out.append(f'<text x="{x}" y="36" font-family="monospace" font-size="20" '
                   f'fill="#948d84">{s}px</text>')
        x += s * Z + GAPX
    import base64
    for r, (label, ang, fill, widen) in enumerate(VARIANTS):
        y = 60 + r * rowh
        out.append(f'<text x="10" y="{y + 40}" font-family="monospace" font-size="19" '
                   f'fill="#948d84">{label}</text>')
        lamp = 0.46 if 'lamp' in label else 0.0
        art = B.tile(quill(best[ang], ang, fill, widen=widen, lamp=lamp))
        open('render/_fv.svg', 'w').write(art)
        x = PADL
        for s in SIZES:
            o = f'render/_fv{s}.png'
            subprocess.run(['inkscape', 'render/_fv.svg', '--export-type=png',
                            f'--export-filename={o}', '-w', str(s), '-h', str(s)],
                           capture_output=True)
            b = base64.b64encode(open(o, 'rb').read()).decode()
            out.append(f'<image x="{x}" y="{y}" width="{s * Z}" height="{s * Z}" '
                       f'image-rendering="pixelated" xlink:href="data:image/png;base64,{b}" '
                       f'xmlns:xlink="http://www.w3.org/1999/xlink"/>')
            x += s * Z + GAPX
    out.append('</svg>')
    open('render/_favicon.svg', 'w').write('\n'.join(out))
    subprocess.run(['inkscape', 'render/_favicon.svg', '--export-type=png',
                    '--export-filename=render/_favicon.png', '-w', str(min(W, 1400))],
                   capture_output=True)
    for f in os.listdir('render'):
        if f.startswith('_fv') or f.startswith('_q.'):
            os.remove(os.path.join('render', f))
    print('render/_favicon.png')


if __name__ == '__main__':
    main()
