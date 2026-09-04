/**
 * Job registry for long setup work.
 *
 * A `deep` ingest is minutes of crawling, so the request that starts it cannot be
 * the request that returns it. Jobs are in-process and pollable: start one, get
 * an id, poll for progress. That is enough for a single-user local tool and it
 * avoids dragging in a queue or a websocket layer for one screen.
 *
 * Progress is reported as *stages*, not a percentage, because the honest answer
 * during a crawl is "fetching page 340 of maybe 600" and a fake percentage is
 * worse than a real count.
 */
import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  stage: string;
  /** Free-form detail, e.g. "crawling: 240 pages". */
  detail: string;
  /** Known-total counter where one exists; null while a crawl is still expanding. */
  current: number;
  total: number | null;
}

export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  progress: JobProgress;
  log: string[];
  result: T | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JobHandle {
  /** Set the current stage. Resets the counters. */
  stage(stage: string, detail?: string): void;
  /** Update counters within a stage. */
  count(current: number, total?: number | null): void;
  log(message: string): void;
  /** True once cancellation has been requested; long loops should check it. */
  cancelled(): boolean;
}

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private cancels = new Set<string>();
  /** Keep finished jobs briefly so a poll after completion still sees the result. */
  private maxKept: number;

  constructor(maxKept = 20) {
    this.maxKept = maxKept;
  }

  start<T>(kind: string, work: (handle: JobHandle) => Promise<T>): Job<T> {
    const id = `job:${randomUUID()}`;
    const job: Job<T> = {
      id,
      kind,
      status: 'running',
      progress: { stage: 'starting', detail: '', current: 0, total: null },
      log: [],
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(id, job as Job);

    const handle: JobHandle = {
      stage: (stage, detail = '') => {
        job.progress = { stage, detail, current: 0, total: null };
        job.log.push(stage + (detail ? `: ${detail}` : ''));
      },
      count: (current, total = null) => {
        job.progress.current = current;
        job.progress.total = total;
      },
      log: (message) => {
        job.log.push(message);
        // A runaway log is a memory leak in a long crawl.
        if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
      },
      cancelled: () => this.cancels.has(id),
    };

    // Deliberately not awaited: the caller gets the id immediately.
    void work(handle)
      .then((result) => {
        if (this.cancels.has(id)) {
          job.status = 'cancelled';
        } else {
          job.result = result;
          job.status = 'done';
          job.progress.stage = 'done';
        }
      })
      .catch((err: unknown) => {
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.progress.stage = 'failed';
        job.log.push(`failed: ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        this.cancels.delete(id);
        this.prune();
      });

    return job;
  }

  get<T = unknown>(id: string): Job<T> | undefined {
    return this.jobs.get(id) as Job<T> | undefined;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Requests cancellation. Cooperative: the work function has to check
   * `handle.cancelled()`, because there is no safe way to interrupt a crawl
   * mid-write and leave the graph consistent.
   */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    this.cancels.add(id);
    job.log.push('cancellation requested');
    return true;
  }

  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
    while (finished.length > this.maxKept) {
      const oldest = finished.shift();
      if (oldest) this.jobs.delete(oldest.id);
    }
  }
}
