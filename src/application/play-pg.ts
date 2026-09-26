import { seedConsequences, tickConsequences, worldTick, type TickResult } from '../consequence/propagate-pg.ts';
import type { Db } from '../db/pg.ts';
import type { Engine, TakeTurnOptions, TurnOutcome } from '../loop/engine-pg.ts';
import { recordAuthoringCheckpoint } from '../loop/history-pg.ts';
import type { World } from '../store/index-pg.ts';
import { runPlayTurn, type PlayWorkflowAdapter } from './play-workflow.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
}

type Adapter = PlayWorkflowAdapter<World, TurnOutcome, TickResult>;

function postCommit(db: Db, takeTurn: Adapter['takeTurn']): Adapter {
  return {
    takeTurn,
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
    recordAuthoringCheckpoint: (resolvedWorld, mutate) => recordAuthoringCheckpoint(db, resolvedWorld, mutate, 'tool:consequences'),
  };
}

/**
 * The complete application workflow for one server-narrated turn.
 *
 * HTTP and MCP are transports over this operation; neither should be able to
 * forget consequence seeding or the world tick after a successful commit.
 */
export async function playTurn(db: Db, engine: Engine, world: World, input: string, opts: PlayTurnOptions = {}) {
  return runPlayTurn(
    postCommit(db, (resolvedWorld, text, options) =>
      engine.takeTurn(text, {
        world: resolvedWorld,
        overrideIntegrity: options.overrideIntegrity,
        ...(options.onStage ? { onStage: options.onStage } : {}),
        ...(options.onToken ? { onToken: options.onToken } : {}),
      }),
    ),
    world,
    input,
    opts,
  );
}

/** The second half of the MCP split turn, followed by the same consequence workflow as `playTurn`. */
export async function commitNarration(
  db: Db,
  engine: Engine,
  world: World,
  resumeToken: string,
  prose: string,
  agentWorld?: unknown,
) {
  return runPlayTurn(
    postCommit(db, (resolvedWorld) => engine.commitExternalNarration(resumeToken, prose, resolvedWorld, agentWorld)),
    world,
    '',
  );
}
