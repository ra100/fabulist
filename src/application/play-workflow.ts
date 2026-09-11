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
    seeded = await adapter.seedConsequences(world, outcome.delta, outcome.commit.events);
    tick = await adapter.tickConsequences(world);
    await adapter.worldTick(world);
  }
  return { outcome, seeded, tick };
}
