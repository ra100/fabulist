/**
 * Branching. See DESIGN.md §11.
 *
 * Full retcon means recomputing every downstream consequence, and the design is
 * explicit that branching gets ~80% of the value at ~5% of the cost. So the past
 * is edited by forking a save at a scene rather than by rewriting history in
 * place, which also means the original playthrough is never destroyed.
 *
 * The copy is a straight file copy of the SQLite database followed by a truncate,
 * which is both simpler and safer than reconstructing state by replaying a delta
 * log: it cannot drift from what actually happened.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { World } from '../store/index.ts';
import { tx } from '../db/db.ts';

export interface BranchResult {
  path: string;
  atScene: number;
  removed: {
    turns: number;
    events: number;
    consequences: number;
    facts: number;
    chronicleEntities: number;
    chronicleEdges: number;
    retiredEdgesRestored: number;
    threads: number;
    divergences: number;
  };
}

/**
 * Truncates an open world back to the state at the *start* of `scene`.
 *
 * Canon is never touched — it is the source material, and a branch is a different
 * playthrough of the same material, not a different universe.
 */
export function truncateToScene(world: World, scene: number): BranchResult['removed'] {
  return tx(world.db, () => {
    const count = (sql: string, ...args: unknown[]) =>
      Number((world.db.prepare(sql).get(...(args as never[])) as { n?: number } | undefined)?.n ?? 0);

    const removed = {
      turns: count(`SELECT COUNT(*) n FROM turns WHERE scene >= ?`, scene),
      events: count(`SELECT COUNT(*) n FROM events WHERE scene >= ?`, scene),
      consequences: count(`SELECT COUNT(*) n FROM consequences WHERE created_scene >= ?`, scene),
      facts: count(`SELECT COUNT(*) n FROM facts WHERE scene >= ?`, scene),
      chronicleEntities: count(`SELECT COUNT(*) n FROM entities WHERE layer = 'chronicle' AND created_scene >= ?`, scene),
      chronicleEdges: count(`SELECT COUNT(*) n FROM edges WHERE layer = 'chronicle' AND valid_from >= ?`, scene),
      retiredEdgesRestored: count(`SELECT COUNT(*) n FROM edges WHERE valid_to IS NOT NULL AND valid_to >= ?`, scene),
      threads: count(`SELECT COUNT(*) n FROM threads WHERE created_scene >= ?`, scene),
      divergences: count(`SELECT COUNT(*) n FROM divergences WHERE scene >= ?`, scene),
    };

    world.db.prepare(`DELETE FROM turns WHERE scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM events WHERE scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM consequences WHERE created_scene >= ?`).run(scene);
    // fact_knowledge cascades on the facts delete; knowledge acquired later about
    // an older fact has to go separately.
    world.db.prepare(`DELETE FROM facts WHERE scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM fact_knowledge WHERE since_scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM entities WHERE layer = 'chronicle' AND created_scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM edges WHERE layer = 'chronicle' AND valid_from >= ?`).run(scene);

    // An edge retired during the discarded scenes was live at the branch point,
    // so un-expire it. Without this, the branch inherits relationships that
    // ended because of events that no longer happened.
    world.db.prepare(`UPDATE edges SET valid_to = NULL WHERE valid_to IS NOT NULL AND valid_to >= ?`).run(scene);

    world.db.prepare(`DELETE FROM threads WHERE created_scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM divergences WHERE scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM scenes WHERE scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM style_anchors WHERE scene >= ?`).run(scene);
    world.db.prepare(`DELETE FROM directives WHERE created_scene >= ?`).run(scene);

    // Vows broken in the discarded future are unbroken again: the break was an
    // event, and that event is gone.
    for (const sheet of world.cast.list()) {
      const vows = sheet.contract.vows.map((v) =>
        v.broken && v.brokenScene !== null && v.brokenScene >= scene
          ? { ...v, broken: false, brokenScene: null }
          : v,
      );
      if (vows.some((v, i) => v.broken !== sheet.contract.vows[i]?.broken)) {
        world.cast.put({ ...sheet, contract: { ...sheet.contract, vows } });
      }
    }

    world.session.set({ scene, turn: 0 });
    return removed;
  });
}

export interface BranchOptions {
  /** Path of the save to branch from. Must be a real file, not :memory:. */
  fromPath: string;
  /** Path for the new save. */
  toPath: string;
  /** The branch resumes at the start of this scene. */
  atScene: number;
  overwrite?: boolean;
}

/**
 * Forks a save at a scene. The source is left completely untouched, which is the
 * property that makes this worth using: a branch is cheap and reversible, so
 * there is no reason to be careful with it.
 */
export function branchSave(opts: BranchOptions): BranchResult {
  const { fromPath, toPath, atScene } = opts;
  if (!existsSync(fromPath)) throw new Error(`no save at ${fromPath}`);
  if (existsSync(toPath) && !opts.overwrite) throw new Error(`${toPath} already exists (pass overwrite to replace)`);
  if (atScene < 1) throw new Error('scene must be 1 or greater');

  mkdirSync(dirname(toPath), { recursive: true });

  // WAL means recent writes may live in a sidecar file, so checkpoint the source
  // into the main database before copying it.
  const source = World.open(fromPath);
  try {
    source.db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  } finally {
    source.close();
  }

  copyFileSync(fromPath, toPath);

  const branch = World.open(toPath);
  try {
    const removed = truncateToScene(branch, atScene);
    return { path: toPath, atScene, removed };
  } finally {
    branch.close();
  }
}
