import type { Timeline } from './api.ts';

export type TimelineRefreshState = {
  timeline: Timeline | null;
  reveal: Set<number>;
};

export function clearTimelineRefreshState(): TimelineRefreshState {
  return { timeline: null, reveal: new Set<number>() };
}
