/**
 * Crossover: composing several canon worlds into one story.
 *
 * "Harry Potter x LotR" is the ask this exists for. The overlay already reads N
 * worlds in `story_sources` order (see `src/db/overlay.ts`), so most of the
 * capability is free — a crossover is the ordinary code path with more than one
 * source. What this module adds is the part that is not free: telling the player
 * where the two worlds *collide*, and giving colliding ids distinct names when
 * they do.
 *
 * ## Why collisions happen, and how rare they are
 *
 * Ids are deterministic slugs of (type, title) — `slugId` in `ingest/parse.ts` —
 * which is what makes re-ingest idempotent. It also means two unrelated worlds
 * mint the same id whenever they happen to share a page title. Measured on the
 * real corpora, Star Trek (33,332 canon entities) and Mass Effect (11,680)
 * collide on exactly **6** ids:
 *
 *     loc:luna, char:april, char:warren,
 *     concept:engineer, concept:century, concept:invasion
 *
 * Six out of 45,012. That number is why aliasing is per-collision rather than
 * per-world: prefixing every id with its world would namespace all 45,012, break
 * the `char:`/`loc:` prefix assumptions in `setup/apply.ts` and
 * `web/src/App.tsx`, and make canon un-refreshable independently. Rewriting six
 * costs nothing and leaves the rest untouched.
 *
 * ## What a collision means for play
 *
 * Without aliasing the overlay resolves a collision by precedence: ordinal 1
 * wins and the other world's entity is unreachable. That is a *correct* rule but
 * a poor experience — "Luna Lovegood shadows Luna the moon" is a decision the
 * player should make knowingly. So:
 *
 *   - `findCollisions` reports them before a crossover starts.
 *   - `aliasCollisions` gives the shadowed ones distinct composed ids
 *     (`<alias>:<localId>`), so both are reachable.
 *   - Canon is never rewritten. The alias table is per story, which is what keeps
 *     each world independently refreshable — the property Phase 3 depends on.
 */
import type { Db, Queryable } from '../db/pg.ts';
import { slugify } from '../store/index-pg.ts';
import type { StoryId } from '../domain/types.ts';

export interface Collision {
  /** The id both worlds mint. */
  id: string;
  /** Every world claiming it, in the story's precedence order. */
  claimants: Array<{ worldId: number; slug: string; ordinal: number; name: string; type: string }>;
}

/**
 * Ids claimed by more than one of a story's canon sources.
 *
 * A self-join on `canon_entities` restricted to the story's worlds: cheap,
 * because `(world_id, id)` is the primary key on both sides. Measured at 44 ms
 * across the real Star Trek and Mass Effect canons (45,012 rows).
 */
export async function findCollisions(db: Queryable, storyId: StoryId): Promise<Collision[]> {
  const { rows } = await db.query<{
    id: string;
    world_id: string;
    slug: string;
    ordinal: number;
    name: string;
    type: string;
  }>(
    `WITH src AS (
       SELECT ss.world_id, ss.ordinal, w.slug FROM story_sources ss
         JOIN worlds w ON w.id = ss.world_id
        WHERE ss.story_id = $1
     ),
     dupes AS (
       SELECT c.id FROM canon_entities c
         JOIN src ON src.world_id = c.world_id
        WHERE c.retired_at_revision IS NULL
        GROUP BY c.id HAVING count(DISTINCT c.world_id) > 1
     )
     SELECT c.id, c.world_id, src.slug, src.ordinal, c.name, c.type
       FROM canon_entities c
       JOIN src ON src.world_id = c.world_id
       JOIN dupes d ON d.id = c.id
      WHERE c.retired_at_revision IS NULL
      ORDER BY c.id, src.ordinal`,
    [storyId],
  );

  const byId = new Map<string, Collision>();
  for (const r of rows) {
    const entry = byId.get(r.id) ?? { id: r.id, claimants: [] };
    entry.claimants.push({
      worldId: Number(r.world_id),
      slug: r.slug,
      ordinal: r.ordinal,
      name: r.name,
      type: r.type,
    });
    byId.set(r.id, entry);
  }
  return [...byId.values()];
}

export interface AliasResult {
  /** One entry per id that was given a namespaced name. */
  aliased: Array<{ localId: string; composedId: string; worldId: number; slug: string }>;
  /** Collisions found, whether or not they were aliased. */
  collisions: number;
}

/**
 * Gives every shadowed claimant of a colliding id a distinct composed id.
 *
 * The ordinal-1 claimant keeps the bare id, so the primary world reads exactly as
 * it would alone — a crossover must not change how the world you started from
 * behaves. Only the shadowed ones are renamed, and only for this story.
 *
 * The composed id is `<world alias>:<local id>` — `middle-earth:loc:luna`. Ugly,
 * and deliberately so: it is visible in the graph view and in a frame, which is
 * how a player notices that two worlds disagreed about a name rather than
 * wondering why one of them vanished.
 *
 * `alias` defaults to the world's slug, slugified again in case a slug ever
 * carries a character an id should not.
 */
export async function aliasCollisions(db: Db, storyId: StoryId): Promise<AliasResult> {
  const collisions = await findCollisions(db, storyId);
  const result: AliasResult = { aliased: [], collisions: collisions.length };
  if (!collisions.length) return result;

  await db.tx(async (tx) => {
    // Recomputed rather than merged: a refresh can create or resolve collisions,
    // so the alias set is derived state and stale entries would point at ids that
    // no longer collide.
    await tx.query(`DELETE FROM story_id_aliases WHERE story_id = $1`, [storyId]);

    const aliasFor = new Map<number, string>();
    for (const c of collisions) {
      for (const claim of c.claimants) {
        if (!aliasFor.has(claim.worldId)) aliasFor.set(claim.worldId, slugify(claim.slug));
      }
    }

    for (const c of collisions) {
      // Skip the first claimant: ordinal 1 keeps the bare id.
      for (const claim of c.claimants.slice(1)) {
        const alias = aliasFor.get(claim.worldId)!;
        const composedId = `${alias}:${c.id}`;
        await tx.query(
          `INSERT INTO story_id_aliases (story_id, world_id, local_id, composed_id)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (story_id, composed_id) DO UPDATE SET local_id = EXCLUDED.local_id, world_id = EXCLUDED.world_id`,
          [storyId, claim.worldId, c.id, composedId],
        );
        result.aliased.push({ localId: c.id, composedId, worldId: claim.worldId, slug: claim.slug });
      }
    }

    // The alias is also written onto story_sources, so a reader that has the
    // sources list does not need a second query to know each world's prefix.
    for (const [worldId, alias] of aliasFor) {
      await tx.query(`UPDATE story_sources SET alias = $1 WHERE story_id = $2 AND world_id = $3`, [
        alias,
        storyId,
        worldId,
      ]);
    }
  });

  return result;
}

/**
 * Resolves a composed id back to (world, local id).
 *
 * Needed by anything that takes an id from the player or the model and has to
 * find the row: the alias exists only in this story's namespace, so the
 * translation cannot live in the overlay queries.
 */
export async function resolveAlias(
  db: Queryable,
  storyId: StoryId,
  composedId: string,
): Promise<{ worldId: number; localId: string } | undefined> {
  const { rows } = await db.query<{ world_id: string; local_id: string }>(
    `SELECT world_id, local_id FROM story_id_aliases WHERE story_id = $1 AND composed_id = $2`,
    [storyId, composedId],
  );
  return rows[0] ? { worldId: Number(rows[0].world_id), localId: rows[0].local_id } : undefined;
}

/** Every alias for a story, for the graph view and the frame builder. */
export async function listAliases(
  db: Queryable,
  storyId: StoryId,
): Promise<Array<{ composedId: string; localId: string; worldId: number }>> {
  const { rows } = await db.query<{ composed_id: string; local_id: string; world_id: string }>(
    `SELECT composed_id, local_id, world_id FROM story_id_aliases WHERE story_id = $1 ORDER BY composed_id`,
    [storyId],
  );
  return rows.map((r) => ({ composedId: r.composed_id, localId: r.local_id, worldId: Number(r.world_id) }));
}

/**
 * How many entities each source contributes to a story's frame budget.
 *
 * Two canons roughly double the candidate pool, and salience is not comparable
 * across worlds: an ingest that happened to score its entities higher would crowd
 * the other world out of every frame, so a Middle-earth crossover could quietly
 * become a Middle-earth story with Hogwarts scenery. This computes a per-source
 * cap that divides the budget rather than letting one source win it.
 *
 * Proportional-with-a-floor rather than a flat split: a 22-entity world composed
 * with a 33,332-entity one should not get half the frame, but it must not get
 * zero either, or the crossover has no trace of it. The floor is deliberately
 * generous relative to typical budgets (a handful of slots) because the *point* of
 * a crossover is that both worlds are present.
 */
export async function frameBudgetPerSource(
  db: Queryable,
  storyId: StoryId,
  totalBudget: number,
): Promise<Array<{ worldId: number; ordinal: number; cap: number }>> {
  const { rows } = await db.query<{ world_id: string; ordinal: number; n: string }>(
    `SELECT ss.world_id, ss.ordinal,
            (SELECT count(*) FROM canon_entities c
              WHERE c.world_id = ss.world_id AND c.retired_at_revision IS NULL) n
       FROM story_sources ss WHERE ss.story_id = $1 ORDER BY ss.ordinal`,
    [storyId],
  );
  if (!rows.length) return [];
  if (rows.length === 1) {
    return [{ worldId: Number(rows[0]!.world_id), ordinal: rows[0]!.ordinal, cap: totalBudget }];
  }

  const sizes = rows.map((r) => ({ worldId: Number(r.world_id), ordinal: r.ordinal, n: Number(r.n) }));
  const total = sizes.reduce((sum, s) => sum + s.n, 0) || 1;
  // At least a quarter of an even split, so the smaller world always shows up.
  const floor = Math.max(1, Math.floor(totalBudget / rows.length / 4));

  return sizes.map((s) => ({
    worldId: s.worldId,
    ordinal: s.ordinal,
    cap: Math.max(floor, Math.round((s.n / total) * totalBudget)),
  }));
}
