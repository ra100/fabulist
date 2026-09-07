/**
 * The mark: a drawn nib.
 *
 * It appears in the masthead, in the wizard and on every scene break — one shape in
 * three places, which is what makes it a mark rather than a decoration. Drawn rather
 * than set in type, so it never depends on a font shipping the ornament, and it
 * inherits `currentColor` so each preset tints it.
 *
 * The path data is **generated**, not drawn here, so this can never drift from the app
 * icon it is supposed to match:
 *
 *     python3 .design/brand/marginalia.py --mark
 *
 * Two things about it are size decisions rather than taste, and both were settled by
 * rendering at 13px and looking (`.design/brand/render/_mark.png`):
 *
 *  - The cut is at its base width. Widening it — which is what the ≤48px *icon* does so
 *    the cut survives the pixel grid — inverts figure and ground at this size: the
 *    interior becomes a teardrop and the mark reads as a map pin. At base width the cut
 *    stays a slit and the shape stays a nib.
 *  - `size` is the **height**. The nib is taller than it is wide (0.7329), so forcing a
 *    square box would letterbox it and the mark would render smaller than asked.
 */

/** Ink-tight viewBox: no padding, so the caller's `size` is the mark's real height. */
const VIEWBOX = '138 130 236 322';
const RATIO = 0.7329;

/** The holder. A separate shape behind the body, so the body keeps a full round dome. */
const BARREL = 'M208.8 188 L212.58 130 L299.42 130 L303.2 188 Z';

/** Body with the vent-and-slit cut knocked out of it in one path. */
const BODY =
  'M256 158 C374 178.58 374 225.62 374 246.2 C374 346.16 303.2 393.2 256 452 ' +
  'C208.8 393.2 138 346.16 138 246.2 C138 225.62 138 178.58 256 158 Z ' +
  'M223 246.2 a33 33 0 1 1 66 0 C289 310.88 257.4 369.68 256 399.08 ' +
  'C254.6 369.68 223 310.88 223 246.2 Z';

export function Mark({ size = 13 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={Math.round(size * RATIO)}
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
