/**
 * The pack registry.
 *
 * Packs are TypeScript modules rather than JSON files on disk for two reasons
 * that both come down to catching mistakes early. A pack is a dense mesh of
 * entity ids referenced from edges, sheets, focus maps, conditions,
 * relationships, facts and threads, and a single mistyped id is a dangling
 * reference the applier will silently drop; `tsc` catches the shape and the
 * pack tests catch the references, before anything is installed. And `data/` is
 * gitignored — it holds saves, not shipped content — so authored worlds need a
 * tracked home regardless.
 *
 * The applier (`packs/apply.ts`) takes plain data and never touches this module,
 * so loading a user-supplied JSON pack through the same validation later is a
 * loader, not a redesign.
 */
import type { WorldPack } from './types.ts';
import { verrowPack } from './verrow.ts';
import { theNineDebtsPack } from './the-nine-debts.ts';
import { theDrawPack } from './the-draw.ts';
import { theQuarantineYearPack } from './the-quarantine-year.ts';
import { harbourLanePack } from './harbour-lane.ts';

/**
 * Order is the order the gallery shows them in, so it is editorial rather than
 * alphabetical: Saint Verrow first because it is the smallest and most
 * immediately legible, then one of each genre.
 */
export const PACKS: WorldPack[] = [
  verrowPack,
  theDrawPack,
  theNineDebtsPack,
  theQuarantineYearPack,
  harbourLanePack,
];

export function packById(id: string): WorldPack | undefined {
  return PACKS.find((p) => p.id === id);
}

/** Gallery view: everything the picker needs without shipping every entity to the client. */
export interface PackSummary {
  id: string;
  title: string;
  genre: WorldPack['genre'];
  blurb: string;
  premise: string;
  entities: number;
  scenarios: Array<{ id: string; title: string; premise: string; playerName: string }>;
}

export function packSummaries(): PackSummary[] {
  return PACKS.map((p) => ({
    id: p.id,
    title: p.title,
    genre: p.genre,
    blurb: p.blurb,
    premise: p.premise,
    entities: p.entities.length,
    scenarios: p.scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      premise: s.premise,
      // The picker shows who you would be playing, which is the single most
      // useful thing about a scenario and is otherwise buried in an id.
      playerName: p.entities.find((e) => e.id === s.playerCharacterId)?.name ?? s.playerCharacterId,
    })),
  }));
}

export { installPack, lintPack, danglingIds } from './apply.ts';
export type { InstallResult, InstalledScenario } from './apply.ts';
export type { WorldPack } from './types.ts';
