import type { Job } from './api.ts';

export interface JobPollerOptions<T> {
  poll: () => Promise<Job<T>>;
  onJob: (job: Job<T>) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
}

export interface JobPoller {
  start: () => void;
  stop: () => void;
}

/**
 * Poll one setup job at a time. A timeout is scheduled only after the previous
 * request settles, so a slow response cannot overlap a later poll.
 */
export function createJobPoller<T>({
  poll,
  onJob,
  onError,
  intervalMs = 700,
}: JobPollerOptions<T>): JobPoller {
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delay: number) => {
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const next = await poll();
      if (stopped) return;
      onJob(next);
      if (next.status === 'running') schedule(intervalMs);
    } catch (error) {
      if (stopped) return;
      onError(error);
      schedule(intervalMs);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
