import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SIMULATION_NODES, shouldSimulateGraph } from '../web/src/views/graphLayout.ts';

test('force simulation is enabled only below the large-graph safety cap', () => {
  assert.equal(shouldSimulateGraph(0), false);
  assert.equal(shouldSimulateGraph(-1), false);
  assert.equal(shouldSimulateGraph(Number.NaN), false);
  assert.equal(shouldSimulateGraph(Number.POSITIVE_INFINITY), false);
  assert.equal(shouldSimulateGraph(1), true);
  assert.equal(shouldSimulateGraph(MAX_SIMULATION_NODES), true);
  assert.equal(shouldSimulateGraph(MAX_SIMULATION_NODES + 1), false);
});
