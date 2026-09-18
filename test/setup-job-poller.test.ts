import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobPoller } from '../web/src/setup-job-poller.ts';
import type { Job } from '../web/src/api.ts';

const runningJob = (id: string): Job => ({
  id,
  kind: 'ingest',
  status: 'running',
  progress: { stage: 'working', detail: '', current: 0, total: null },
  log: [],
  result: null,
  error: null,
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('setup job polling serializes requests and retries visible failures', async () => {
  const requests: Array<() => void> = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const errors: unknown[] = [];
  const jobs: Job[] = [];
  let callCount = 0;
  const poller = createJobPoller({
    intervalMs: 0,
    poll: async () => {
      callCount++;
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => requests.push(resolve));
      inFlight--;
      return runningJob(String(callCount));
    },
    onJob: (job) => jobs.push(job),
    onError: (error) => errors.push(error),
  });

  poller.start();
  await wait(5);
  assert.equal(requests.length, 1);
  assert.equal(peakInFlight, 1);
  requests.shift()?.();
  await wait(5);
  assert.equal(requests.length, 1);
  assert.equal(peakInFlight, 1);
  poller.stop();

  const retryPoller = createJobPoller({
    intervalMs: 0,
    poll: async () => {
      throw new Error('temporary outage');
    },
    onJob: () => {},
    onError: (error) => errors.push(error),
  });
  retryPoller.start();
  await wait(5);
  retryPoller.stop();
  assert.ok(errors.some((error) => error instanceof Error && error.message === 'temporary outage'));
});
