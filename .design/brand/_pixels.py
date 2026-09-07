"""Pixel test for the small sizes.

Scaling a 512 drawing down in a vector viewer flatters it. This rasterises each
concept at 16, 20 and 32 device pixels, then magnifies the result with nearest-
neighbour so the actual pixels are visible — which is what a browser tab shows.
Left block of each pair is the 512 drawing shrunk; right block is the size-specific
drawing. If the right is not clearly better, the size-specific drawing is not
earning its keep.
"""
import subprocess, os, base64

os.chdir(os.path.dirname(os.path.abspath(__file__)))
NAMES = ['nib', 'rubric', 'strata', 'gauge', 'folio', 'seal']
SIZES = [16, 20, 32]
ZOOM = 7
GAPX, GAPY, PAD = 22, 26, 130


def raster(src, px):
    out = f'render/_p{px}_{os.path.basename(src)}.png'
    subprocess.run(['inkscape', src, '--export-type=png', '--export-filename=' + out,
                    '-w', str(px), '-h', str(px)], capture_output=True)
    return base64.b64encode(open(out, 'rb').read()).decode()


rowh = max(SIZES) * ZOOM + GAPY
blockw = sum(s * ZOOM for s in SIZES) + GAPX * (len(SIZES) - 1)
W = PAD + blockw * 2 + 90
H = 60 + rowh * len(NAMES)
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
       f'<rect width="{W}" height="{H}" fill="#1a1714"/>',
       f'<text x="{PAD}" y="34" font-family="monospace" font-size="20" fill="#948d84">'
       f'512 drawing, shrunk</text>',
       f'<text x="{PAD + blockw + 90}" y="34" font-family="monospace" font-size="20" '
       f'fill="#e9b452">size-specific drawing</text>']
for r, name in enumerate(NAMES):
    y = 56 + r * rowh
    out.append(f'<text x="10" y="{y + 44}" font-family="monospace" font-size="19" '
               f'fill="#948d84">{name}</text>')
    for blk, src in enumerate((f'icon-{name}.svg', f'icon-{name}-16.svg')):
        x = PAD + blk * (blockw + 90)
        for px in SIZES:
            b64 = raster(src, px)
            side = px * ZOOM
            out.append(f'<image x="{x}" y="{y}" width="{side}" height="{side}" '
                       f'image-rendering="pixelated" '
                       f'xlink:href="data:image/png;base64,{b64}" '
                       f'xmlns:xlink="http://www.w3.org/1999/xlink"/>')
            x += side + GAPX
out.append('</svg>')
open('render/_pixels.svg', 'w').write('\n'.join(out))
subprocess.run(['inkscape', 'render/_pixels.svg', '--export-type=png',
                '--export-filename=render/_pixels.png', '-w', str(min(W, 1500))],
               capture_output=True)
print('render/_pixels.png')
