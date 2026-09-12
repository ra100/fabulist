import type { World } from '../store/index.ts';

/** Records an immutable post-authoring snapshot without replacing a turn checkpoint. */
export function recordAuthoringCheckpoint(world: World): void {
  world.history.capture();
}
