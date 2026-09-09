/**
 * The five roles, Postgres. See DESIGN.md §4 and §9.
 *
 * This file converted almost mechanically, and the reason is `RoleDeps.ctx`: every
 * role already built its frame through that one seam rather than reaching into the
 * world itself. Extending it to also carry the prefetched `FrameData` (see
 * `frame/builders-pg.ts` for why frames are built from a snapshot) means the roles
 * keep their shape — one `ctx()` call, one `build*Frame()` call — and the engine
 * owns loading the data once per turn instead of each role paying for it.
 *
 * The only genuinely async additions are the handful of direct store reads:
 * `classify` resolving target names, and `integrity`/`narrate` fetching the actor's
 * sheet.
 */
import type {
  CoherenceDistance,
  Delta,
  EntityId,
  IntegrityVerdict,
  Intent,
  Interrupt,
  RefereeVerdict,
  SessionState,
  StyleContract,
} from '../domain/types.ts';
import {
  buildDirectorFrame,
  buildExtractFrame,
  buildIntegrityFrame,
  buildNarratorFrame,
  buildRefereeFrame,
  type FrameData,
  type FrameContext,
} from '../frame/builders-pg.ts';
import { adaptRequest, extractJson, type Provider } from '../providers/provider.ts';
import type { World } from '../store/index-pg.ts';
import {
  coerceDelta,
  deltaSchema,
  directorSchema,
  integritySchema,
  intentSchema,
  refereeSchema,
  validateDelta,
  type ValidationResult,
} from './validate-pg.ts';

export interface RoleDeps {
  world: World;
  provider: (role: string) => Provider;
  ctx: (role: string, extra?: Partial<FrameContext>) => FrameContext;
  /**
   * The turn's prefetched world snapshot, loaded once by the engine.
   *
   * Carried on `deps` rather than passed to each role, so a role signature does
   * not have to change every time a builder needs another slot — and so it is
   * impossible for one role to build its frame from a *different* snapshot than
   * another, which would produce a turn where the Referee and the Narrator
   * disagree about who is in the room.
   */
  data: FrameData;
  log: (role: string, provider: string, model: string, tokensIn: number, tokensOut: number) => void;
}

async function callJson(
  deps: RoleDeps,
  role: string,
  system: string,
  user: string,
  schema: { name: string; schema: Record<string, unknown> },
  retries = 1,
): Promise<unknown> {
  const provider = deps.provider(role);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const messages = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ];
    if (attempt > 0) {
      // Repair prompt. Cheap, and it rescues most malformed replies without a
      // model swap; the alternative is discarding a turn's state entirely.
      messages.push({
        role: 'user' as const,
        content: `Your previous reply could not be parsed as JSON matching the schema. Reply with only the JSON object.`,
      });
    }
    const req = adaptRequest({ messages, role, schema, temperature: 0 }, provider.capabilities);
    const res = await provider.complete(req);
    deps.log(role, provider.id, res.model, res.tokensIn, res.tokensOut);
    try {
      return extractJson(res.text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${role}: unparseable response after ${retries + 1} attempts: ${String(lastErr)}`);
}

// ------------------------------------------------------------------ classify

const CLASSIFY_SYSTEM = `You classify a player's input in a role-play session.
Decide whether it is an in-fiction action, spoken dialogue, an out-of-character
directive to the game master, or a question about the world.

Set verbatim=true only when the player wrote finished prose in their character's
voice that deserves to appear in the book unchanged. Shorthand and note-form
input is not verbatim.

Reply with JSON only.`;

export async function classify(deps: RoleDeps, rawInput: string, actorId: EntityId): Promise<Intent> {
  const raw = (await callJson(
    deps,
    'classify',
    CLASSIFY_SYSTEM,
    `<player-input>\n${rawInput}\n</player-input>`,
    intentSchema,
  )) as Record<string, unknown>;

  const targetNames = Array.isArray(raw.targetNames) ? raw.targetNames.map(String) : [];
  // Resolved before the synchronous map below, because `resolveName` is a query
  // now. One per distinct named target, which is a handful per turn — and each is
  // the deliberately-exact resolution `GraphStore.resolveName` documents, so these
  // are separate lookups rather than a set-membership test that could be batched.
  const resolvedTargets = new Map<string, string | undefined>();
  for (const n of targetNames) {
    if (resolvedTargets.has(n)) continue;
    resolvedTargets.set(n, (await deps.world.graph.resolveName(n))?.id);
  }
  const targetIds = targetNames
    .map((n) => resolvedTargets.get(n))
    .filter((id): id is string => !!id);

  return {
    class: (raw.class as Intent['class']) ?? 'action',
    actorId,
    action: typeof raw.action === 'string' ? raw.action : rawInput.slice(0, 120),
    targetIds,
    manner: typeof raw.manner === 'string' ? raw.manner : '',
    dialogueGist: typeof raw.dialogueGist === 'string' ? raw.dialogueGist : null,
    verbatim: raw.verbatim === true,
  };
}

// ----------------------------------------------------------------- integrity

const INTEGRITY_SYSTEM = `You judge whether an action fits the character taking it.

You are protecting the player's character from being played wrongly, not
policing content. Score the coherence distance:

- in-character:     consistent with the sheet
- stretch:          unusual but reachable; the character would feel it
- off-key:          needs justification the scene has not supplied
- contract-breach:  violates a ranked vow with nothing in the scene compelling it
- incoherent:       no continuity with this character at all

Weigh vow rank: rank 1 is nearly inviolable. A vow already broken constrains
much less. If the scene genuinely compels the act (mortal threat, protecting
someone under the character's own drives), prefer 'stretch' over a breach.

Reply with JSON only.`;

export async function integrity(
  deps: RoleDeps,
  rawInput: string,
  actorId: EntityId,
): Promise<IntegrityVerdict> {
  const world = deps.world;
  const sheet = await world.cast.get(actorId);

  // No contract means nothing to check; skip the call entirely rather than
  // paying for a verdict that can only be 'in-character'.
  if (!sheet || sheet.contract.vows.length === 0) {
    return { distance: 'in-character', violatedVows: [], reasoning: 'no contract to check', interrupt: null };
  }

  const strictness = (await world.session.get()).knobs.characterStrictness;
  if (strictness === 'permissive') {
    return { distance: 'in-character', violatedVows: [], reasoning: 'gate disabled', interrupt: null };
  }

  const ctx = deps.ctx('integrity', { rawInput });
  const frame = buildIntegrityFrame(ctx, deps.data, actorId);
  const raw = (await callJson(deps, 'integrity', INTEGRITY_SYSTEM, frame.text, integritySchema)) as Record<
    string,
    unknown
  >;

  const distance = (raw.distance as CoherenceDistance) ?? 'in-character';
  const violatedVows = Array.isArray(raw.violatedVowIds)
    ? raw.violatedVowIds.map(String).filter((id) => sheet.contract.vows.some((v) => v.id === id && !v.broken))
    : [];
  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';

  const interrupt = shouldInterrupt(distance, strictness)
    ? await buildInterrupt(deps, actorId, violatedVows, distance)
    : null;

  return { distance, violatedVows, reasoning, interrupt };
}

/**
 * `strict` (the default) interrupts only on genuine breach, so the interrupt
 * keeps its weight. `iron` also stops on off-key. `coaching` never interrupts
 * and relies on in-fiction resistance instead (DESIGN §5.3).
 */
export function shouldInterrupt(distance: CoherenceDistance, strictness: string): boolean {
  if (strictness === 'permissive' || strictness === 'coaching') return false;
  if (strictness === 'iron') return distance === 'off-key' || distance === 'contract-breach' || distance === 'incoherent';
  return distance === 'contract-breach' || distance === 'incoherent';
}

/**
 * The interrupt is writing, not a UX string. It names the contract, explains
 * why it blocks, and always offers an override — an author must be able to break
 * their own character on purpose.
 */
async function buildInterrupt(
  deps: RoleDeps,
  actorId: EntityId,
  violatedVows: string[],
  distance: CoherenceDistance,
): Promise<Interrupt> {
  const world = deps.world;
  const entity = await world.graph.get(actorId);
  const sheet = await world.cast.getOrBlank(actorId);
  const name = entity?.name ?? actorId;
  const vows = sheet.contract.vows.filter((v) => violatedVows.includes(v.id));
  const vowText = vows.map((v) => v.text).join('; ');

  const message =
    distance === 'incoherent'
      ? `That does not read like ${name} at all, and I would rather ask than write something you did not mean.`
      : `${name} holds this: ${vowText || 'a vow they have not broken'}. Nothing in this scene forces it. ` +
        `Taken straight, this is not a choice they have access to.`;

  return {
    message,
    options: [
      { key: 'a', label: 'Rewrite it — I want a different approach', effect: 'revise' },
      {
        key: 'b',
        label: `Something has broken in ${name}. Establish what, and play the fallout.`,
        effect: 'establish-break',
      },
      { key: 'c', label: 'I meant a different character', effect: 'switch-character' },
      { key: 'd', label: 'Override — deliberate heel turn, play it straight', effect: 'override' },
    ],
  };
}

// ------------------------------------------------------------------- referee

const REFEREE_SYSTEM = `You adjudicate whether a player's action is possible in this world.

Lean permissive. Being loose about world facts costs nothing and buys
improvisation; being strict makes you worse company than a game master who
improvises freely.

Escalate only as far as needed:
- allow            harmless or interesting; canonise it
- allow-with-cost  it works, but the world charges for it
- reinterpret      nearly right; bend it to fit what is true
- friction         it fails for a reason the world supplies, in fiction
- contradiction    only for a hard contradiction with established state

If the player references something that does not exist but should, put it in
'spawn' and allow it. Never refuse flatly.

Reply with JSON only.`;

export async function referee(deps: RoleDeps, rawInput: string): Promise<RefereeVerdict> {
  const ctx = deps.ctx('referee', { rawInput });
  const frame = buildRefereeFrame(ctx, deps.data);
  const raw = (await callJson(deps, 'referee', REFEREE_SYSTEM, frame.text, refereeSchema)) as Record<string, unknown>;

  const spawn = Array.isArray(raw.spawn)
    ? raw.spawn
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.name === 'string' && s.name.length > 0)
        .map((s) => ({
          type: (String(s.type ?? 'Concept') as RefereeVerdict['spawn'][number]['type']),
          name: String(s.name),
          summary: String(s.summary ?? ''),
        }))
    : [];

  return {
    ruling: (raw.ruling as RefereeVerdict['ruling']) ?? 'allow',
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
    cost: typeof raw.cost === 'string' ? raw.cost : null,
    spawn,
  };
}

// ------------------------------------------------------------------ director

export const GM_MOVES = [
  'reveal an unwelcome truth',
  'offer an opportunity, with a cost',
  'put someone in a spot',
  'use up their resources',
  'turn their own move against them',
  'announce off-screen badness',
  'have an NPC act on their own agenda',
  'make the world push back physically',
] as const;

const DIRECTOR_SYSTEM = `You decide what happens next, choosing from a fixed menu of moves.

Available moves:
${GM_MOVES.map((m) => `- ${m}`).join('\n')}

Pick the move that best serves the highest-tension thread that has an opening
here. Constrained choice beats free invention: it produces more legible
behaviour and it can be explained afterwards.

Honour active directives. A 'mandate' must be satisfied, but prefer to satisfy
it through characters pursuing their own agendas rather than an event dropping
from the sky.

Sometimes the right answer is a quiet beat. Not every turn needs escalation.

Reply with JSON only.`;

export interface DirectorPlan {
  move: string;
  threadId: string | null;
  beat: string;
  reasoning: string;
}

export async function direct(deps: RoleDeps, rawInput: string): Promise<DirectorPlan> {
  const ctx = deps.ctx('director', { rawInput });
  const frame = buildDirectorFrame(ctx, deps.data);
  const raw = (await callJson(deps, 'director', DIRECTOR_SYSTEM, frame.text, directorSchema)) as Record<string, unknown>;
  return {
    move: typeof raw.move === 'string' ? raw.move : GM_MOVES[0],
    threadId: typeof raw.threadId === 'string' ? raw.threadId : null,
    beat: typeof raw.beat === 'string' ? raw.beat : 'continue',
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
  };
}

// ------------------------------------------------------------------ narrator

/**
 * Exported (unlike the other role prompt builders) so a caller that skips the
 * narrator role entirely — an MCP tool handing the frame to an external
 * model, see `src/mcp/` — can still show that model the exact system prompt
 * the in-process Narrator would have used. Keeping this identical between
 * the two paths is what makes the style contract mean the same thing whether
 * the prose comes from this engine's own provider or from whatever wrote it
 * on the other end of an MCP tool call.
 */
export function narratorSystem(style: StyleContract, verbatim: boolean): string {
  return `You are the narrator of a role-play session. You write prose and nothing else.

You do not invent world facts. Render what the referee and director already
agreed on. If you need a detail they did not supply, keep it small and sensory
rather than consequential.

The player writes in shorthand. Turn it into finished prose in the established
voice. ${
    verbatim
      ? 'The player wrote polished prose this turn: preserve their sentences and build around them rather than paraphrasing.'
      : 'Their phrasing is a sketch, not a quote — you may render the gist freely.'
  }

Never invent a promise, a threat, or a revealed secret the player did not
specify. Inventing the gist of a line is fine; inventing a commitment is not.

Write plainly and specifically. Avoid stock somatic beats (breaths nobody knew
they were holding, clenching jaws, dropping stomachs), named emotions where a
shown one would do, and portentous one-line endings.

Do not write a heading, a preamble, or any commentary. Prose only.

Style contract:
pov: ${style.pov}
tense: ${style.tense}
register: ${style.register}
density: ${style.density}
genre: ${style.genreLens}
target: about ${style.sceneTarget} words`;
}

/**
 * Assembles exactly what the narrator role would send a provider, without
 * sending it. Exported for the MCP tool path (`src/mcp/tools.ts`), which
 * skips this engine's own Narrator role and hands an external model
 * (whatever wrote the request — Claude, ChatGPT, anything else speaking MCP)
 * the identical system prompt and scene frame instead, so the style contract
 * is honoured the same way regardless of which model ends up writing the
 * prose. `narrate()` below is now a thin wrapper: build the prompt, send it,
 * log the call — kept as one function for every caller that still wants the
 * engine to narrate for itself.
 */
export function buildNarratorPrompt(
  deps: RoleDeps,
  rawInput: string,
  agreedBeat: string,
  verbatim: boolean,
): { system: string; user: string; maxTokens: number } {
  const ctx = deps.ctx('narrate', { rawInput, agreedBeat });
  const frame = buildNarratorFrame(ctx, deps.data);
  const style = ctx.session.style;
  return {
    system: narratorSystem(style, verbatim),
    user: frame.text,
    maxTokens: Math.max(512, Math.ceil(style.sceneTarget * 2)),
  };
}

export async function narrate(
  deps: RoleDeps,
  rawInput: string,
  agreedBeat: string,
  verbatim: boolean,
  onToken?: (chunk: string) => void,
): Promise<string> {
  const { system, user, maxTokens } = buildNarratorPrompt(deps, rawInput, agreedBeat, verbatim);
  const provider = deps.provider('narrate');

  const req = adaptRequest(
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      role: 'narrate',
      maxTokens,
      temperature: 0.8,
      ...(onToken ? { onToken } : {}),
    },
    provider.capabilities,
  );
  const res = await provider.complete(req);
  deps.log('narrate', provider.id, res.model, res.tokensIn, res.tokensOut);
  return res.text.trim();
}

// ------------------------------------------------------------------- extract

const EXTRACT_SYSTEM = `You convert narrated prose into a structured state delta.

This is the contract that keeps the world consistent: anything the prose implies
but you omit did not happen. Record what changed, not what was described.

Rules:
- Use only entity ids listed in <known-ids>. To introduce something new, add it
  to entityUpserts with a new id of the form type:kebab-name.
- Record an event for anything consequential. Set significance 0..1.
- factsLearned is for information a character now holds. List exactly who knows
  it and who merely suspects. Do not add the player unless the prose shows them
  learning it.
- edgeRetires is for relations that ended. Do not retire what was never asserted.
- Set sceneAdvance true only if the prose clearly changes place or time.

Reply with JSON only.`;

export async function extract(
  deps: RoleDeps,
  prose: string,
  rawInput: string,
): Promise<{ delta: Delta; validation: ValidationResult }> {
  const ctx = deps.ctx('extract', { rawInput });
  const frame = buildExtractFrame(ctx, deps.data, prose);
  const raw = await callJson(deps, 'extract', EXTRACT_SYSTEM, frame.text, deltaSchema, 2);

  const { delta, issues } = coerceDelta(raw);
  const validation = await validateDelta(deps.world, delta);
  validation.issues = [...issues, ...validation.issues];
  validation.ok = validation.issues.filter((i) => !i.repaired).length === 0;
  return { delta, validation };
}

export type { SessionState };
