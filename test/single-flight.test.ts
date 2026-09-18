import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleFlightController } from '../web/src/views/singleFlight.ts';

test('single-flight controller ignores repeated starts and recovers after failure', async () => {
  const controller = createSingleFlightController();
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = controller.start(async () => {
    calls++;
    await pending;
  });
  const second = controller.start(async () => {
    calls++;
  });

  assert.equal(controller.isRunning(), true);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(controller.isRunning(), false);

  await assert.rejects(
    controller.start(async () => {
      calls++;
      throw new Error('tick failed');
    }),
    /tick failed/,
  );
  assert.equal(controller.isRunning(), false);
  await controller.start(async () => {
    calls++;
  });
  assert.equal(calls, 3);
});
