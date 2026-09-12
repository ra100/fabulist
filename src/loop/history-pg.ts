import type { Db } from '../db/pg.ts';
import type { Engine } from './engine-pg.ts';
import type { StoryLayout, StoryLayoutTurn } from '../domain/types.ts';
import { World } from '../store/index-pg.ts';

const DEFAULT_CHAPTER_SIZE = 8;

export async function storyLayout(world: World, chapterSize = DEFAULT_CHAPTER_SIZE): Promise<StoryLayout> {
  const [turns, eligibleTurns, segmentStarts, session] = await Promise.all([
    world.chronicle.turns({ limit: 5000 }), world.history.eligibleTurns(), world.history.sceneStartPositions(), world.session.get(),
  ]);
  const eligible = new Map(eligibleTurns.map((turn) => [turn.turnId, turn]));
  const boundaries = new Set(segmentStarts);
  turns.sort((left, right) => {
    const leftPosition = eligible.get(left.id)?.position;
    const rightPosition = eligible.get(right.id)?.position;
    return leftPosition !== undefined && rightPosition !== undefined
      ? leftPosition - rightPosition
      : left.scene - right.scene || left.turn - right.turn;
  });
  let previousRawScene: number | undefined;
  let scene = 0;
  const layoutTurns: StoryLayoutTurn[] = [];
  for (const source of turns) {
    const history = eligible.get(source.id);
    const boundary = history ? boundaries.has(history.position) : false;
    const startsScene = layoutTurns.length === 0 || previousRawScene !== source.scene || (boundary && layoutTurns.length > 0);
    if (startsScene) scene += 1;
    layoutTurns.push({
      turnId: source.id, scene, chapter: Math.floor((scene - 1) / chapterSize) + 1, turn: source.turn,
      startsScene, eligible: Boolean(history), position: history?.position ?? null, source,
    });
    previousRawScene = source.scene;
  }
  return { turns: layoutTurns, currentScene: Math.max(scene, session.scene) };
}

export async function splitSceneAtTurn(world: World, turnId: string) {
  const apply = async (transactionWorld: World) => {
    const split = await transactionWorld.history.splitBefore(turnId);
    const layout = await storyLayout(transactionWorld);
    const target = layout.turns.find((turn) => turn.turnId === turnId)!;
    const affectedScene = Math.max(1, target.scene - 1);
    await transactionWorld.chronicle.invalidateSummariesFrom(
      affectedScene, Math.floor((affectedScene - 1) / DEFAULT_CHAPTER_SIZE) + 1,
    );
    const last = layout.turns.at(-1);
    await transactionWorld.session.set({ scene: layout.currentScene, turn: last?.turn ?? 0 });
    return split;
  };
  const database = world.db as Db;
  if (typeof database.tx !== 'function') return apply(world);
  return database.tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [world.storyId]);
    return apply(new World({
      db: client, storyId: world.storyId, sources: world.sources, imagesDir: world.illustrations.imagesDir, crypto: world.crypto,
    }));
  });
}

export async function reconcileContinuation(world: World): Promise<void> {
  const layout = await storyLayout(world);
  const last = layout.turns.at(-1);
  await world.session.set({ scene: layout.currentScene, turn: last?.turn ?? 0 });
  await world.db.query(`UPDATE stories SET active_scene_segment_id = $1 WHERE id = $2`, [
    last?.position == null ? null : await world.history.activeSegmentAt(last.position),
    world.storyId,
  ]);
}

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
