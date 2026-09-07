"""Gallery sheets — for looking at, not for shipping.

Two images: the chosen mark in its tiers, and the whole catalogue. Regenerate with

    python3 .design/brand/gallery.py

Nothing here is a deliverable; the deliverables are the icon-*.svg files.
"""
import subprocess, os
import build as B

S = B.S
INK, INK3, RULE2, GOLD, GOLD_M = B.INK, B.INK3, B.RULE2, B.GOLD, B.GOLD_M
BG = '#1a1714'


def read(name):
    return open(f'icon-{name}.svg').read()


def head(x, y, text, size=30, fill=None):
    return (f'<text x="{x}" y="{y}" font-family="monospace" font-size="{size}" '
            f'fill="{fill or INK}">{text}</text>')


def rule(x, y, w):
    return f'<path d="M{x} {y} H{x + w}" stroke="{RULE2}" stroke-width="2"/>'


# ---------------------------------------------------------------- sheet 1 · the pick
def gallery_pick():
    master, small, engraved = (read('marginalia-page'),
                               read('marginalia-page-16'),
                               read('marginalia-page-engraved-16'))
    PAD, GAP = 44, 40
    parts, uid = [], [0]

    def place(svg, x, y, sz):
        uid[0] += 1
        body = B.uniq(svg, f'g{uid[0]}')
        parts.append(f'<g transform="translate({x},{y}) scale({sz / S})">{body}</g>')

    W = 1560
    y = PAD + 34
    parts.append(head(PAD, y, 'THE PICK · marginalia-page', 34, GOLD))
    y += 16
    parts.append(rule(PAD, y, W - PAD * 2))
    y += 40
    parts.append(head(PAD, y, 'master — serves 512 / 180 / 96', 24, INK3))
    y += 26

    x = PAD
    for sz in (512, 180, 96):
        place(master, x, y + (512 - sz), sz)
        parts.append(head(x, y + 512 + 32, str(sz), 22, INK3))
        x += sz + GAP
    y += 512 + 70

    parts.append(rule(PAD, y, W - PAD * 2))
    y += 40
    parts.append(head(PAD, y, 'small tier — serves 48 and below · two options', 24, INK3))
    y += 30

    for label, svg, note in (
            ('icon-marginalia-page-16.svg', small,
             "the master's nib isolated — same gold, same collar, same cut"),
            ('…-engraved-16.svg', engraved,
             'the engraved variant\u2019s sibling — bone, so its lamp reads')):
        parts.append(head(PAD, y + 30, label, 26, INK))
        parts.append(head(PAD, y + 58, note, 20, GOLD_M if 'isolated' in note else RULE2))
        x = PAD + 520
        for sz in (48, 32, 24, 16):
            place(svg, x, y + 8, sz)
            # and a magnified copy beside each, so the pixels are visible
            place(svg, x + sz + 14, y + 8, sz * 4)
            parts.append(head(x, y + sz * 4 + 34, f'{sz} · ×4', 18, RULE2))
            x += sz + sz * 4 + 58
        y += 240

    H = y + 20
    out = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="{BG}"/>'
           + ''.join(parts) + '</svg>')
    open('render/_gallery-pick.svg', 'w').write(out)
    subprocess.run(['inkscape', 'render/_gallery-pick.svg', '--export-type=png',
                    '--export-filename=render/_gallery-pick.png', '-w', '1400'],
                   capture_output=True)
    print('render/_gallery-pick.png')


# ---------------------------------------------------------------- sheet 2 · everything
def gallery_all():
    DRAFTS = [('nib', 'the instrument, alone'),
              ('rubric', 'the rubricated initial'),
              ('strata', 'prose over graph'),
              ('gauge', 'the instrument scale'),
              ('folio', 'the folio marginal'),
              ('seal', 'seal × instrument dial')]
    JOKE = [('marginalia-1', 'plausible · 18°'),
            ('marginalia-2', 'noticeable · upright'),
            ('marginalia-3', 'not subtle · full almond'),
            ('marginalia-flagged', 'flagged: diverged'),
            ('marginalia-page', 'doodle in the margin — THE PICK'),
            ('marginalia-page-engraved', 'engraved — THE PICK')]

    BIG, SM, PAD, GAP, COLS = 210, 42, 44, 60, 6
    colw = BIG + GAP
    W = PAD * 2 + colw * COLS - GAP + 40
    parts, uid = [], [0]

    def place(svg, x, y, sz):
        uid[0] += 1
        parts.append(f'<g transform="translate({x},{y}) scale({sz / S})">'
                     f'{B.uniq(svg, f"a{uid[0]}")}</g>')

    y = PAD + 34

    def section(title, items, mark=None):
        nonlocal y
        parts.append(head(PAD, y, title, 32, GOLD))
        y += 16
        parts.append(rule(PAD, y, W - PAD * 2))
        y += 34
        for i, (name, note) in enumerate(items):
            x = PAD + (i % COLS) * colw
            svg = read(name)
            place(svg, x, y, BIG)
            place(svg, x, y + BIG + 12, SM)
            place(svg, x + SM + 8, y + BIG + 12, 24)
            place(svg, x + SM + 8 + 24 + 8, y + BIG + 12, 16)
            hot = mark and name == mark
            parts.append(head(x, y + BIG + SM + 40, name, 19, GOLD if hot else INK))
            parts.append(head(x, y + BIG + SM + 62, note, 15, GOLD_M if hot else RULE2))
        y += BIG + SM + 150

    section('SIX DRAFTS', DRAFTS)
    section('THE MARGINALIA SET — the joke on purpose, on a dial',
            JOKE, mark='marginalia-page')

    H = y
    out = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
           f'viewBox="0 0 {W} {H}"><rect width="{W}" height="{H}" fill="{BG}"/>'
           + ''.join(parts) + '</svg>')
    open('render/_gallery-all.svg', 'w').write(out)
    subprocess.run(['inkscape', 'render/_gallery-all.svg', '--export-type=png',
                    '--export-filename=render/_gallery-all.png', '-w', '1400'],
                   capture_output=True)
    print('render/_gallery-all.png')


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    os.makedirs('render', exist_ok=True)
    gallery_pick()
    gallery_all()
