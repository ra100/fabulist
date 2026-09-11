import { seedConsequences, tickConsequences, worldTick } from '../consequence/propagate-pg.ts';
import type { Engine, TakeTurnOptions } from '../loop/engine-pg.ts';
import type { World } from '../store/index-pg.ts';
import { runPlayTurn } from './play-workflow.ts';

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
  return runPlayTurn(
    {
      takeTurn: (resolvedWorld, text, options) =>
        engine.takeTurn(text, {
          world: resolvedWorld,
          overrideIntegrity: options.overrideIntegrity,
          ...(options.onStage ? { onStage: options.onStage } : {}),
          ...(options.onToken ? { onToken: options.onToken } : {}),
        }),
      seedConsequences: async (resolvedWorld, delta, events) =>
        (
          await seedConsequences(
            resolvedWorld,
            delta as Parameters<typeof seedConsequences>[1],
            events as Parameters<typeof seedConsequences>[2],
          )
        ).length,
      tickConsequences,
      worldTick,
    },
    world,
    input,
    opts,
  );
}
