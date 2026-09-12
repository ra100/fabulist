import type { StoryLayout, StoryLayoutTurn } from '../domain/types.ts';
import { tx } from '../db/db.ts';
import type { World } from '../store/index.ts';

const DEFAULT_CHAPTER_SIZE = 8;

export function storyLayout(world: World, chapterSize = DEFAULT_CHAPTER_SIZE): StoryLayout {
  const turns = world.chronicle.turns({ limit: 5000 });
  const eligible = new Map(world.history.eligibleTurns().map((turn) => [turn.turnId, turn]));
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
    const boundary = history ? world.history.startsScene(source.id) : false;
    const startsScene = layoutTurns.length === 0 || previousRawScene !== source.scene || (boundary && layoutTurns.length > 0);
    if (startsScene) scene += 1;
    layoutTurns.push({
      turnId: source.id, scene, chapter: Math.floor((scene - 1) / chapterSize) + 1, turn: source.turn,
      startsScene, eligible: Boolean(history), position: history?.position ?? null, source,
    });
    previousRawScene = source.scene;
  }
  return { turns: layoutTurns, currentScene: Math.max(scene, world.session.get().scene) };
}

export function splitSceneAtTurn(world: World, turnId: string) {
  return tx(world.db, () => {
    const split = world.history.splitBefore(turnId);
    const layout = storyLayout(world);
    const target = layout.turns.find((turn) => turn.turnId === turnId)!;
    const affectedScene = Math.max(1, target.scene - 1);
    world.chronicle.invalidateSummariesFrom(affectedScene, Math.floor((affectedScene - 1) / DEFAULT_CHAPTER_SIZE) + 1);
    const last = layout.turns.at(-1);
    world.session.set({ scene: layout.currentScene, turn: last?.turn ?? 0 });
    return split;
  });
}

/** Records an immutable post-authoring snapshot without replacing a turn checkpoint. */
export function recordAuthoringCheckpoint(world: World): void {
  world.history.capture();
}
