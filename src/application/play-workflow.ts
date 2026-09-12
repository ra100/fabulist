export interface NarratedOutcome {
  kind: string;
  delta?: unknown;
  commit?: { events: unknown[] };
}

export interface PlayWorkflowAdapter<World, Outcome extends NarratedOutcome, Tick> {
  takeTurn(
    world: World,
    input: string,
    options: { overrideIntegrity: boolean; onStage?: (stage: string) => void; onToken?: (chunk: string) => void },
  ): Promise<Outcome>;
  seedConsequences(world: World, delta: unknown, events: unknown[]): number | Promise<number>;
  tickConsequences(world: World): Tick | Promise<Tick>;
  worldTick(world: World): unknown | Promise<unknown>;
  /** Wraps post-turn authored state and its checkpoint in one persistence transaction. */
  recordAuthoringCheckpoint?<T>(world: World, mutate: (world: World) => Promise<T>): Promise<T>;
}

export interface PlayWorkflowOptions {
  overrideIntegrity?: boolean;
  onStage?: (stage: string) => void;
  onToken?: (chunk: string) => void;
}

/**
 * Transport-neutral orchestration for a narrated turn.
 *
 * Persistence-specific engines and consequence stores stay behind the adapter;
 * HTTP and MCP callers receive the same post-commit workflow.
 */
export async function runPlayTurn<World, Outcome extends NarratedOutcome, Tick>(
  adapter: PlayWorkflowAdapter<World, Outcome, Tick>,
  world: World,
  input: string,
  options: PlayWorkflowOptions = {},
): Promise<{ outcome: Outcome; seeded: number; tick: Tick | null }> {
  const outcome = await adapter.takeTurn(world, input, {
    overrideIntegrity: options.overrideIntegrity === true,
    ...(options.onStage ? { onStage: options.onStage } : {}),
    ...(options.onToken ? { onToken: options.onToken } : {}),
  });

  let seeded = 0;
  let tick: Tick | null = null;
  if (outcome.kind === 'narrated' && outcome.delta !== undefined && outcome.commit) {
    const mutate = async (transactionWorld: World): Promise<[number, Tick]> => {
      const seeded = await adapter.seedConsequences(transactionWorld, outcome.delta!, outcome.commit!.events);
      const tick = await adapter.tickConsequences(transactionWorld);
      await adapter.worldTick(transactionWorld);
      return [seeded, tick];
    };
    [seeded, tick] = adapter.recordAuthoringCheckpoint
      ? await adapter.recordAuthoringCheckpoint(world, mutate)
      : await mutate(world);
  }
  return { outcome, seeded, tick };
}
