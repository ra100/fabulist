import { seedConsequences, tickConsequences, worldTick, type TickResult } from '../consequence/propagate.ts';
import type { Engine, TakeTurnOptions, TurnOutcome } from '../loop/engine.ts';
import { recordAuthoringCheckpointTx } from '../loop/history.ts';
import type { World } from '../store/index.ts';
import { runPlayTurn, type PlayWorkflowAdapter } from './play-workflow.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
}

type Adapter = PlayWorkflowAdapter<World, TurnOutcome, TickResult>;

function postCommit(takeTurn: Adapter['takeTurn']): Adapter {
  return {
    takeTurn,
    seedConsequences: (resolvedWorld, delta, events) =>
      seedConsequences(
        resolvedWorld,
        delta as Parameters<typeof seedConsequences>[1],
        events as Parameters<typeof seedConsequences>[2],
      ).length,
    tickConsequences,
    worldTick,
    recordAuthoringCheckpoint: recordAuthoringCheckpointTx,
  };
}

export function playTurn(engine: Engine, world: World, input: string, options: PlayTurnOptions = {}) {
  return runPlayTurn(
    postCommit((resolvedWorld, text, opts) =>
      engine.takeTurn(text, {
        world: resolvedWorld,
        overrideIntegrity: opts.overrideIntegrity,
        ...(opts.onStage ? { onStage: opts.onStage } : {}),
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
      }),
    ),
    world,
    input,
    options,
  );
}

/** The second half of the MCP split turn, followed by the same consequence workflow as `playTurn`. */
export function commitNarration(engine: Engine, world: World, resumeToken: string, prose: string, agentWorld?: unknown) {
  return runPlayTurn(
    postCommit((resolvedWorld) => engine.commitExternalNarration(resumeToken, prose, resolvedWorld, agentWorld)),
    world,
    '',
  );
}
