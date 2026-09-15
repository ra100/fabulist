/**
 * Keep the hand-rolled force layout responsive when a story contains a large
 * graph. Beyond this point the seeded positions remain usable, but quadratic
 * repulsion is too expensive to run on the main thread.
 */
export const MAX_SIMULATION_NODES = 250;

export function shouldSimulateGraph(nodeCount: number): boolean {
  return nodeCount > 0 && nodeCount <= MAX_SIMULATION_NODES;
}
