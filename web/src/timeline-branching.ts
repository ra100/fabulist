import type { Timeline } from './api.ts';

export function canBranchFromTimelineScene(timeline: Pick<Timeline, 'currentScene'>, scene: Pick<Timeline['scenes'][number], 'scene'>): boolean {
  return scene.scene < timeline.currentScene;
}
