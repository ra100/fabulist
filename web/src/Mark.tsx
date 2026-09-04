/**
 * The mark: a drawn nib.
 *
 * It appears in the masthead, in the wizard and on every scene break — one shape
 * in three places, which is what makes it a mark rather than a decoration. Drawn
 * rather than set in type, so it never depends on a font shipping the ornament,
 * and it inherits `currentColor` so each preset tints it.
 */
export function Mark({ size = 13 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* A single silhouette. An inner slit turns to mush below ~20px, so the
          shape carries it alone and the shoulder notch does the describing. */}
      <path
        d="M8 0.9c3.1 3.7 4.1 6.8 0 14.2-4.1-7.4-3.1-10.5 0-14.2Z"
        fill="currentColor"
      />
    </svg>
  );
}
