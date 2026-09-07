/**
 * The mark, full — nib, ruled edge and page.
 *
 * `Mark` is the glyph: the nib alone, set inline against type at cap height. This is the
 * whole lockup, for the masthead, where it stands taller than the title and reads as a
 * logo rather than as an ornament beside a word.
 *
 * The geometry is **generated**, not drawn here, so it cannot drift from the app icon:
 *
 *     python3 .design/brand/marginalia.py --header
 *
 * Three things about it are decisions rather than defaults:
 *
 *  - **No tile.** The icon's dark ground and rounded corners are right for a file standing
 *    on its own; inside a bar that already has a surface they would be a box drawn inside
 *    a box. So this is artwork on transparency.
 *  - **Four paragraph lines, not the icon's ten.** Below roughly 64px the master's ten
 *    lines stop reading as text and become a grey slab. A masthead gives about 30px, so
 *    the page is redrawn at four heavier lines with a short last one, which still reads as
 *    prose at 24px (`.design/brand/render/_headerlockup.png`).
 *  - **The nib takes `currentColor`; the page and the rule take tokens.** The nib is the
 *    accent and follows the palette preset, exactly as the inline mark does. The page is
 *    ink and the ruled edge is a rule, so they read their own tokens and no colour is
 *    named here.
 */

/** Ink-tight viewBox, so the caller's `height` is the lockup's real height. */
const VIEWBOX = '91.8 118 358.2 276';
const RATIO = 1.298;

const NIB_TRANSFORM = 'translate(-84,0) translate(81.9,81.9) scale(0.68)';
const NIB_BARREL = 'M208.8 188 L212.58 130 L299.42 130 L303.2 188 Z';
const NIB_BODY =
  'M256 158 C374 178.58 374 225.62 374 246.2 C374 346.16 303.2 393.2 256 452 ' +
  'C208.8 393.2 138 346.16 138 246.2 C138 225.62 138 178.58 256 158 Z ' +
  'M223 246.2 a33 33 0 1 1 66 0 C289 310.88 257.4 369.68 256 399.08 ' +
  'C254.6 369.68 223 310.88 223 246.2 Z';

const RULE_X = 272;
const PARA_X = 300;
const PARA_STROKE = 26;

/** y, width, and whether the line sits in the dimmer ink — the last two lines recede. */
const PARA: Array<[number, number, boolean]> = [
  [187, 150, false],
  [233, 141, false],
  [279, 150, true],
  [325, 87, true],
];

export function MarkFull({ height = 30 }: { height?: number }) {
  return (
    <svg
      className="mark-full"
      width={Math.round(height * RATIO)}
      height={height}
      viewBox={VIEWBOX}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={NIB_TRANSFORM} fill="currentColor">
        <path d={NIB_BARREL} />
        <path d={NIB_BODY} fillRule="evenodd" />
      </g>
      <path d={`M${RULE_X} 122 V390`} stroke="var(--rule-strong)" strokeWidth={7} />
      {PARA.map(([y, w, dim]) => (
        <path
          key={y}
          d={`M${PARA_X} ${y} H${PARA_X + w}`}
          stroke={dim ? 'var(--ink-3)' : 'var(--ink-2)'}
          strokeWidth={PARA_STROKE}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
