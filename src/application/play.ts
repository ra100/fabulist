import { seedConsequences, tickConsequences, worldTick } from '../consequence/propagate.ts';
import type { Engine, TakeTurnOptions } from '../loop/engine.ts';
import type { World } from '../store/index.ts';
import { runPlayTurn } from './play-workflow.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
}

export function playTurn(engine: Engine, world: World, input: string, options: PlayTurnOptions = {}) {
  return runPlayTurn(
    {
      takeTurn: (resolvedWorld, text, opts) =>
        engine.takeTurn(text, {
          world: resolvedWorld,
          overrideIntegrity: opts.overrideIntegrity,
          ...(opts.onStage ? { onStage: opts.onStage } : {}),
          ...(opts.onToken ? { onToken: opts.onToken } : {}),
        }),
      seedConsequences: (resolvedWorld, delta, events) =>
        seedConsequences(
          resolvedWorld,
          delta as Parameters<typeof seedConsequences>[1],
          events as Parameters<typeof seedConsequences>[2],
        ).length,
      tickConsequences,
      worldTick,
    },
    world,
    input,
    options,
  );
}
