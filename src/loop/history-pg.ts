import type { World } from '../store/index-pg.ts';

/** Records an immutable post-authoring snapshot without replacing a turn checkpoint. */
export async function recordAuthoringCheckpoint(world: World): Promise<void> {
  await world.history.capture();
}
