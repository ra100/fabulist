import { seedConsequences, tickConsequences, worldTick, type TickResult } from '../consequence/propagate-pg.ts';
import type { Db } from '../db/pg.ts';
import type { Engine, TakeTurnOptions, TurnOutcome } from '../loop/engine-pg.ts';
import { recommitTurn } from '../loop/commit-pg.ts';
import { recordAuthoringCheckpoint } from '../loop/history-pg.ts';
import type { Registry } from '../providers/provider.ts';
import type { World } from '../store/index-pg.ts';
import { runPlayTurn, type NarratedOutcome, type PlayWorkflowAdapter } from './play-workflow.ts';

export interface PlayTurnOptions {
  overrideIntegrity?: boolean;
  onStage?: TakeTurnOptions['onStage'];
  onToken?: TakeTurnOptions['onToken'];
  providers?: Registry;
}

type Adapter<Outcome extends NarratedOutcome = TurnOutcome> = PlayWorkflowAdapter<World, Outcome, TickResult>;

function postCommit<Outcome extends NarratedOutcome = TurnOutcome>(
  db: Db,
  takeTurn: Adapter<Outcome>['takeTurn'],
): Adapter<Outcome> {
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
        ...(opts.providers ? { providers: opts.providers } : {}),
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
  providers?: Registry,
) {
  return runPlayTurn(
    postCommit(db, (resolvedWorld) => engine.commitExternalNarration(resumeToken, prose, resolvedWorld, agentWorld, providers)),
    world,
    '',
  );
}

/** `replace_turn_prose` with a world: the re-commit gets the same consequence workflow as any commit. */
export async function recommitNarration(db: Db, world: World, turnId: string, prose: string, agentWorld: unknown) {
  return runPlayTurn(
    postCommit(db, (resolvedWorld) => recommitTurn(db, resolvedWorld, turnId, prose, agentWorld)),
    world,
    '',
  );
}
