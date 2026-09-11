import { seedConsequences, tickConsequences, worldTick } from '../consequence/propagate-pg.ts';
import type { Engine, TakeTurnOptions } from '../loop/engine-pg.ts';
import type { World } from '../store/index-pg.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
}

/**
 * The complete application workflow for one server-narrated turn.
 *
 * HTTP and MCP are transports over this operation; neither should be able to
 * forget consequence seeding or the world tick after a successful commit.
 */
export async function playTurn(engine: Engine, world: World, input: string, opts: PlayTurnOptions = {}) {
  const outcome = await engine.takeTurn(input, {
    overrideIntegrity: opts.overrideIntegrity === true,
    world,
    ...(opts.onStage ? { onStage: opts.onStage } : {}),
    ...(opts.onToken ? { onToken: opts.onToken } : {}),
  });

  let seeded = 0;
  let tick: Awaited<ReturnType<typeof tickConsequences>> | null = null;
  if (outcome.kind === 'narrated') {
    seeded = (await seedConsequences(world, outcome.delta, outcome.commit.events)).length;
    tick = await tickConsequences(world);
    await worldTick(world);
  }
  return { outcome, seeded, tick };
}
