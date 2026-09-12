import type { Db } from '../db/pg.ts';
import type { Engine } from './engine-pg.ts';
import { World } from '../store/index-pg.ts';

/**
 * Applies one authoring mutation and records its immutable post-mutation
 * checkpoint on the same client. The story advisory lock serialises the read,
 * mutation, snapshot, and commit against every other authoring write.
 */
export async function recordAuthoringCheckpoint<T>(
  db: Db,
  world: World,
  mutate: (transactionWorld: World) => Promise<T>,
): Promise<T> {
  return db.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [world.storyId]);
    const transactionWorld = new World({
      db: client,
      storyId: world.storyId,
      sources: world.sources,
      imagesDir: world.illustrations.imagesDir,
      crypto: world.crypto,
    });
    const result = await mutate(transactionWorld);
    await transactionWorld.history.capture();
    return result;
  });
}

/**
 * Renders without a checked-out transaction client, then serialises the
 * verify/write/checkpoint sequence under the story lock.
 */
export async function regenerateProseWithCheckpoint(
  db: Db,
  world: World,
  engine: Engine,
  turnId: string,
  opts: { note?: string; onToken?: (chunk: string) => void } = {},
) {
  const rendered = await engine.renderProseRegeneration(turnId, { ...opts, world });
  return recordAuthoringCheckpoint(db, world, (transactionWorld) => engine.persistProseRegeneration(rendered, transactionWorld));
}
