import type { SceneSplitResult, StoryLayout, StoryLayoutTurn } from '../domain/types.ts';
import { tx, txAsync } from '../db/db.ts';
import type { World } from '../store/index.ts';

const DEFAULT_CHAPTER_SIZE = 8;

export function storyLayout(world: World, chapterSize = DEFAULT_CHAPTER_SIZE): StoryLayout {
  const turns = world.chronicle.turns({});
  const eligible = new Map(world.history.eligibleTurns().map((turn) => [turn.turnId, turn]));
  const segments = world.history.sceneSegments();
  const segmentStarts = new Map(segments.map((segment) => [segment.startPosition, segment.id]));
  turns.sort((left, right) => {
    const leftPosition = eligible.get(left.id)?.position;
    const rightPosition = eligible.get(right.id)?.position;
    return leftPosition !== undefined && rightPosition !== undefined
      ? leftPosition - rightPosition
      : left.scene - right.scene || left.turn - right.turn;
  });
  let previousRawScene: number | undefined;
  let segmentId: string | undefined;
  let scene = 0;
  const layoutTurns: StoryLayoutTurn[] = [];
  for (const source of turns) {
    const history = eligible.get(source.id);
    if (previousRawScene !== source.scene) segmentId = undefined;
    const boundary = history ? segmentStarts.has(history.position) : false;
    if (history && segmentStarts.has(history.position) && layoutTurns.length > 0) segmentId = segmentStarts.get(history.position);
    const startsScene = layoutTurns.length === 0 || previousRawScene !== source.scene || (boundary && layoutTurns.length > 0);
    if (startsScene) scene += 1;
    layoutTurns.push({
      turnId: source.id, scene, metadataKey: segmentId ? `segment:${segmentId}` : `raw:${source.scene}`,
      chapter: Math.floor((scene - 1) / chapterSize) + 1, turn: source.turn,
      startsScene, eligible: Boolean(history), position: history?.position ?? null, source,
    });
    previousRawScene = source.scene;
  }
  return { turns: layoutTurns, currentScene: Math.max(scene, world.session.get().scene) };
}

export function splitSceneAtTurn(world: World, turnId: string): SceneSplitResult {
  return tx(world.db, () => {
    const split = world.history.splitBefore(turnId);
    const layout = storyLayout(world);
    const target = layout.turns.find((turn) => turn.turnId === turnId);
    if (!target) throw new Error(`split_scene: committed turn ${turnId} disappeared during split`);
    const affectedScene = Math.max(1, target.scene - 1);
    world.chronicle.invalidateSummariesFrom(affectedScene, Math.floor((affectedScene - 1) / DEFAULT_CHAPTER_SIZE) + 1);
    // A raw-scene summary can span the newly split child. It has no safe
    // range identity, so discard it rather than projecting it onto either side.
    world.db.prepare(`DELETE FROM scene_metadata WHERE story_id = ?`).run(world.storyId);
    world.db.prepare(`UPDATE scenes SET title = '', summary = '' WHERE story_id = ?`).run(world.storyId);
    const last = layout.turns.at(-1);
    world.session.set({ scene: layout.currentScene, turn: last?.turn ?? 0 });
    return {
      ...split,
      target: {
        turnId: target.turnId,
        scene: target.scene,
        chapter: target.chapter,
        turn: target.turn,
        startsScene: target.startsScene,
      },
    };
  });
}

export function reconcileContinuation(world: World): void {
  const layout = storyLayout(world);
  const last = layout.turns.at(-1);
  world.session.set({ scene: layout.currentScene, turn: last?.turn ?? 0 });
  world.db
    .prepare(`UPDATE stories SET active_scene_segment_id = ? WHERE id = ?`)
    .run(last?.position == null ? null : world.history.activeSegmentAt(last.position), world.storyId);
}

/** Records an immutable post-authoring snapshot without replacing a turn checkpoint. */
export function recordAuthoringCheckpoint(world: World, origin?: string): void {
  world.history.capture(undefined, origin);
}

/**
 * The SQLite counterpart of Postgres `history-pg.ts`'s `recordAuthoringCheckpoint`:
 * runs `mutate` and its post-mutation checkpoint capture inside one transaction,
 * so a failure partway through (e.g. `tickConsequences` throwing after
 * `seedConsequences` already wrote pending rows) leaves nothing half-applied.
 * Named distinctly from the void-returning `recordAuthoringCheckpoint` above,
 * which snapshots state that a caller has *already* committed on its own.
 */
export async function recordAuthoringCheckpointTx<T>(
  world: World,
  mutate: (world: World) => Promise<T>,
  origin?: string,
): Promise<T> {
  return txAsync(world.db, async () => {
    const result = await mutate(world);
    world.history.capture(undefined, origin);
    return result;
  });
}
