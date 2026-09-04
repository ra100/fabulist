/**
 * Colour presets.
 *
 * The values live in CSS (one `[data-palette]` block per preset, generated and
 * contrast-verified by .design/palettes.mjs). This module only carries the
 * catalogue and the persistence, so adding a preset means adding a block there
 * and a line here — never touching a component.
 */

export interface Preset {
  key: string;
  label: string;
  mode: 'dark' | 'light';
  /** The source the palette was derived from. This is the tie-breaker for later colour questions. */
  source: string;
}

export const PRESETS: Preset[] = [
  {
    key: 'iron-gall',
    label: 'Iron gall',
    mode: 'dark',
    source: 'Manuscript ink oxidised to warm brown, gold leaf, red-oxide rubric.',
  },
  {
    key: 'foxed',
    label: 'Foxed paper',
    mode: 'light',
    source: 'An aged rag page in daylight, brown-black text, rust foxing.',
  },
  {
    key: 'cyanotype',
    label: 'Cyanotype',
    mode: 'dark',
    source: 'Prussian blue sun-print, paper-white forms, the rust of a failed print.',
  },
  {
    key: 'phosphor',
    label: 'Phosphor',
    mode: 'dark',
    source: 'Green CRT trace behind instrument glass, one amber caution lamp.',
  },
  {
    key: 'lacquer',
    label: 'Lacquer',
    mode: 'dark',
    source: 'Urushi worn through to the vermilion beneath, gold maki-e inlay.',
  },
  {
    key: 'graphite',
    label: 'Graphite',
    mode: 'dark',
    source: 'Cold grey housings, screen-printed legends, one citron indicator.',
  },
];

const STORAGE_KEY = 'fabulist.palette';
const DEFAULT_DARK = 'iron-gall';
const DEFAULT_LIGHT = 'foxed';

const isKnown = (k: string | null): k is string => !!k && PRESETS.some((p) => p.key === k);

/** Stored choice wins; otherwise follow the operating system. */
export function resolvePalette(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isKnown(stored)) return stored;
  } catch {
    // Private mode or blocked storage: fall through to the OS preference.
  }
  const prefersLight =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  return prefersLight ? DEFAULT_LIGHT : DEFAULT_DARK;
}

export function applyPalette(key: string): void {
  document.documentElement.dataset.palette = key;
}

export function savePalette(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Not being able to remember the choice is not worth failing over.
  }
  applyPalette(key);
}

/** Called before first paint, so the chosen preset never flashes the default. */
export function bootPalette(): string {
  const key = resolvePalette();
  applyPalette(key);
  return key;
}
