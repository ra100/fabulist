/**
 * The mark: a drawn nib.
 *
 * The inline glyph, set against type at cap height. It appears in the wizard and on every
 * scene break, and it inherits `currentColor` so each palette preset tints it.
 *
 * It is the *uncropped* nib, where the shipped app icon is a corner crop of the same shape
 * (`.design/brand/icon-quill-corner.svg`). That is deliberate rather than a drift: a crop
 * needs a frame to crop against, and inline type has none. Same shape family, different
 * composition — the normal relationship between a favicon and a wordmark glyph.
 *
 * The path data is **generated**, not drawn here:
 *
 *     python3 .design/brand/marginalia.py --mark
 *
 * Two things about it are size decisions settled by rendering at 13px, not taste
 * (`.design/brand/render/_mark.png`):
 *
 *  - The cut stays at its base width. Widening it inverts figure and ground at this size —
 *    the interior becomes a teardrop and the mark reads as a map pin.
 *  - `size` is the **height**. The nib is far taller than wide (0.3398), so forcing a
 *    square box would letterbox it and the mark would render smaller than asked.
 */

/** Ink-tight viewBox: no padding, so the caller's `size` is the mark's real height. */
const VIEWBOX = '186 62 140 412';
const RATIO = 0.3398;

/** The shaft. A separate shape behind the body, so the body keeps its full shoulder. */
const BARREL = 'M215.4 152 L218.65 62 L293.35 62 L296.6 152 Z';

/** Body with the vent-and-slit cut knocked out of it in one path. */
const BODY =
  'M256 126 C327.4 150.36 326 192.12 326 216.48 C326 376.56 296.6 404.4 256 474 ' +
  'C215.4 404.4 186 376.56 186 216.48 C186 192.12 184.6 150.36 256 126 Z ' +
  'M234 216.48 a22 22 0 1 1 44 0 C278 293.04 257.4 397.44 256 432.24 ' +
  'C254.6 397.44 234 293.04 234 216.48 Z';

export function Mark({ size = 13 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={Math.max(1, Math.round(size * RATIO))}
      height={size}
      viewBox={VIEWBOX}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={BARREL} fill="currentColor" />
      <path d={BODY} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
