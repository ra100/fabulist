/**
 * Colour presets, one per genre.
 *
 * The values live in CSS (one `[data-palette]` block per preset, generated and
 * contrast-verified by .design/palettes.mjs). This module carries the catalogue
 * and the persistence only, so adding a preset means adding a block there and a
 * line here — never touching a component.
 *
 * A genre name on its own is a mood, and a mood forbids nothing. Each preset is
 * therefore pinned to a specific source inside its genre, which is what keeps
 * "science fiction" from collapsing into blue-and-cyan.
 */

export interface Preset {
  key: string;
  label: string;
  /** The genre this preset is for. Shown in the picker. */
  genre: string;
  mode: 'dark' | 'light';
  /** The artefact the palette was derived from. The tie-breaker for later colour questions. */
  source: string;
}

export const PRESETS: Preset[] = [
  {
    key: 'chronicle',
    label: 'Chronicle',
    genre: 'historical · literary',
    mode: 'dark',
    source: 'Iron-gall ink oxidised to warm brown, gold leaf, red-oxide rubric.',
  },
  {
    key: 'starship',
    label: 'Starship',
    genre: 'science fiction · hard',
    mode: 'dark',
    source: 'Apollo panels and the interiors of 2001: one cyan trace, caution orange.',
  },
  {
    key: 'neon',
    label: 'Neon',
    genre: 'science fiction · cyberpunk',
    mode: 'dark',
    source: 'Rain-lit signage over Kowloon. Indigo ground; only the magenta runs hot.',
  },
  {
    key: 'grimoire',
    label: 'Grimoire',
    genre: 'fantasy · high',
    mode: 'dark',
    source: 'Tooled leather and verdigris on bronze, with Rackham’s muted wash.',
  },
  {
    key: 'ember',
    label: 'Ember',
    genre: 'fantasy · dark',
    mode: 'dark',
    source: 'Forge scale under cold bone light, with one ember at the centre.',
  },
  {
    key: 'nocturne',
    label: 'Nocturne',
    genre: 'horror · gothic',
    mode: 'dark',
    source: 'Doré engravings by candlelight. Almost no chroma but the flame.',
  },
  {
    key: 'gaslight',
    label: 'Gaslight',
    genre: 'mystery · noir',
    mode: 'dark',
    source: 'Sodium lamps in fog; amber is the only warm thing in the frame.',
  },
  {
    key: 'ribbon',
    label: 'Ribbon',
    genre: 'romance',
    mode: 'light',
    source: 'Wedgwood jasperware and pressed flowers in a keepsake album.',
  },
  {
    key: 'meadow',
    label: 'Meadow',
    genre: 'casual · slice of life',
    mode: 'light',
    source: 'Beatrix Potter’s washes over picture-book offset, on linen paper.',
  },
];

const STORAGE_KEY = 'fabulist.palette';
const DEFAULT_DARK = 'chronicle';
const DEFAULT_LIGHT = 'meadow';

/** Earlier builds shipped material names. Map them rather than resetting a choice. */
const MIGRATIONS: Record<string, string> = {
  'iron-gall': 'chronicle',
  foxed: 'ribbon',
  cyanotype: 'starship',
  phosphor: 'ember',
  lacquer: 'grimoire',
  graphite: 'gaslight',
};

const isKnown = (k: string | null | undefined): k is string => !!k && PRESETS.some((p) => p.key === k);

/** Stored choice wins, then a migrated older choice, then the operating system. */
export function resolvePalette(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isKnown(stored)) return stored;
    if (stored && isKnown(MIGRATIONS[stored])) return MIGRATIONS[stored]!;
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
