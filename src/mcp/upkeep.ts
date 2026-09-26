import { z } from 'zod';
import type { Delta, Knobs, StyleContract } from '../domain/types.ts';
import type { Registry } from '../providers/provider.ts';

export type Upkeep = 'server' | 'agent';

/** The mock extractor records no cast, facts, edges or threads, so with it the agent must keep the world. */
export function upkeepFor(registry: Registry): Upkeep {
  return registry.get('extract').id === 'mock' ? 'agent' : 'server';
}

export interface GuideInput {
  upkeep: Upkeep;
  writingRules: string;
  style: StyleContract;
  knobs: Knobs;
  anchors: Array<{ text: string; note: string }>;
  blocklist: string[];
}

export interface Guide {
  upkeep: Upkeep;
  loop: string;
  writing: {
    rules: string;
    style: StyleContract;
    knobs: Knobs;
    anchors: Array<{ text: string; note: string }>;
    blocklist: string[];
  };
  validation: string;
  upkeepChecklist?: string[];
}

const LOOP = `Playing a turn
The normal loop is two calls, and skipping the second one loses the turn:
  a. \`propose_turn\` with what the player does, in their words. The server runs its gates
     (does this fit the character, does it fit the world, what happens next) and stops before any
     prose exists. It returns \`narratorSystemPrompt\` + \`sceneFrame\`.
  b. You write the prose from that frame, then call \`commit_narration\` with it and the
     \`resumeToken\`. NOTHING IS SAVED UNTIL THIS CALL. Prose you only put in the chat is not in
     the book; the world model never sees it, and the next turn will not know it happened.
  c. With \`upkeep: "agent"\`, also pass \`world\` to \`commit_narration\`: what this turn changed (see
     upkeepChecklist). With \`upkeep: "server"\`, omit it; the server extracts the change from your prose.
Two other outcomes from (a): \`interrupted\` means the action breaks something the character has
established about themselves — show the player the options and call \`resolve_interrupt\`, not
\`commit_narration\`. \`answered\` means the input was a question about the world, not an action;
there is nothing to narrate.
Prefer \`play\` instead of (a)+(b) only if you want this server's own model to write the prose.

Keeping the book shaped
• \`close_scene\` at a real scene break. Otherwise the whole book stays scene 1 forever, and the
  summarisation that keeps long stories coherent never runs.
• \`get_book\` is the committed text. Read it back if you are unsure whether a turn landed.
• \`update_style\`/\`update_knobs\` change how it is written; \`add_directive\` steers what happens
  next; \`add_anchor\` pins a passage as a style reference.`;

const VALIDATION = `Every turn's world change, extracted or yours, runs through one validator.
Repaired, reported in \`dropped\`, and the turn still commits: an unknown entity id is resolved by name
when it matches one entity, or dropped; an edge with a missing end is dropped; retiring an edge that is
not live is dropped; a vow break naming a vow the character does not hold is dropped; an upsert without
id or name is dropped.
Blocking (\`status: "blocked"\`, nothing commits): a turn with no event at all, or a character recorded
dead taking part in an event. With \`upkeep: "agent"\` an omitted or empty \`events\` becomes one event
from your prose with the present cast, so a missing event list never blocks.`;

const UPKEEP_CHECKLIST = [
  'Cast: add anyone or anything new in entityUpserts (id "type:kebab-name"), after search_entities shows it does not already exist. Sheet changes (wounds, allegiance, appearance) go through update_sheet between turns.',
  'Relationships: edgeAsserts for a typed relation the prose establishes; edgeRetires only for a live edge that ended; relationshipUpdates for trust/affection/respect shifts between two characters.',
  'Facts: factsLearned for information a character now holds, listing exactly who is in knownBy and who is only in suspectedBy. Use record_fact for a fact you missed.',
  'Threads: threadUpdates with a title and no id opens a thread; with an id, move tensionDelta or set status "resolved"/"abandoned". Use open_thread between turns.',
  'Conditions: conditionUpdates for mood, injuries, location or presentWith of anyone the prose changes.',
  'Vows: vowBreaks when a character breaks a vow they hold.',
  'Events: events with participants and significance 0..1; omit to record one event from the prose with the present cast. sceneAdvance: true only when place or time changes.',
  'Consequences are seeded automatically from significant events after each commit. Use add_consequence only for a reaction the prose sets up that the graph cannot infer; its causeEventId is an events[].id from the commit result.',
];

export function buildGuide(input: GuideInput): Guide {
  return {
    upkeep: input.upkeep,
    loop: LOOP,
    writing: {
      rules: input.writingRules,
      style: input.style,
      knobs: input.knobs,
      anchors: input.anchors,
      blocklist: input.blocklist,
    },
    validation: VALIDATION,
    ...(input.upkeep === 'agent' ? { upkeepChecklist: UPKEEP_CHECKLIST } : {}),
  };
}

export function appliedCounts(delta: Delta): Record<string, number> {
  return {
    events: delta.events.length,
    entityUpserts: delta.entityUpserts.length,
    edgeAsserts: delta.edgeAsserts.length,
    edgeRetires: delta.edgeRetires.length,
    conditionUpdates: delta.conditionUpdates.length,
    relationshipUpdates: delta.relationshipUpdates.length,
    factsLearned: delta.factsLearned.length,
    threadUpdates: delta.threadUpdates.length,
    vowBreaks: delta.vowBreaks.length,
    sceneAdvance: delta.sceneAdvance ? 1 : 0,
  };
}

export const worldDeltaInput = z.object({
  events: z
    .array(
      z.object({
        text: z.string(),
        participants: z.array(z.string()).optional(),
        locationId: z.string().nullable().optional(),
        significance: z.number().min(0).max(1).optional(),
      }),
    )
    .optional()
    .describe('What happened. Omit to record one event from the prose with the present cast.'),
  entityUpserts: z
    .array(
      z.object({
        id: z.string().describe('type:kebab-name'),
        type: z.enum(['Character', 'Location', 'Faction', 'Item', 'Concept', 'Event']),
        name: z.string(),
        summary: z.string().optional(),
        props: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  edgeAsserts: z
    .array(z.object({ subject: z.string(), predicate: z.string(), object: z.string(), weight: z.number().min(0).max(1).optional() }))
    .optional(),
  edgeRetires: z.array(z.object({ subject: z.string(), predicate: z.string(), object: z.string() })).optional(),
  conditionUpdates: z.array(z.object({ entityId: z.string(), patch: z.record(z.string(), z.unknown()) })).optional(),
  relationshipUpdates: z
    .array(
      z.object({
        fromId: z.string(),
        toId: z.string(),
        trustDelta: z.number().optional(),
        affectionDelta: z.number().optional(),
        respectDelta: z.number().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  factsLearned: z
    .array(z.object({ text: z.string(), knownBy: z.array(z.string()).optional(), suspectedBy: z.array(z.string()).optional() }))
    .optional(),
  threadUpdates: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        stakes: z.string().optional(),
        tensionDelta: z.number().optional(),
        parties: z.array(z.string()).optional(),
        resolutions: z.array(z.string()).optional(),
        status: z.enum(['open', 'resolved', 'abandoned']).optional(),
      }),
    )
    .optional(),
  vowBreaks: z.array(z.object({ entityId: z.string(), vowId: z.string() })).optional(),
  sceneAdvance: z.boolean().optional(),
});

export const triggerInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }),
  z.object({ kind: z.literal('after-scenes'), scenes: z.number().int().min(1) }),
  z.object({ kind: z.literal('on-enter'), locationId: z.string() }),
  z.object({ kind: z.literal('on-learn'), entityId: z.string(), factId: z.string() }),
]);
