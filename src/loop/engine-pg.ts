/**
 * The turn loop. See DESIGN.md §4.
 *
 * A plain state machine, deliberately. The sequence is fixed and known, so an
 * agent framework would only cost debuggability.
 *
 * Integrity runs before Referee on purpose: there is no point adjudicating
 * whether an act is physically possible if the character would never attempt it,
 * and it is the cheapest call in the loop.
 */
import { randomUUID } from 'node:crypto';
import type {
  Delta,
  EntityId,
  Frame,
  IntegrityVerdict,
  Interrupt,
  LintReport,
  RefereeVerdict,
  SessionState,
  StoryId,
  Turn,
  TurnMeta,
} from '../domain/types.ts';
import { inputBudget } from '../frame/budget.ts';
import type { FrameContext } from '../frame/builders-pg.ts';
import { tokenizerFor } from '../frame/tokenizer.ts';
import type { Provider, Registry } from '../providers/provider.ts';
import type { World } from '../store/index-pg.ts';
import type { Db } from '../db/pg.ts';
import { loadFrameData, type FrameData } from '../frame/builders-pg.ts';
import { commitDelta, type CommitResult } from './commit-pg.ts';
import { Compactor } from './compact-pg.ts';
import {
  buildNarratorPrompt,
  classify,
  type DirectorPlan,
  direct,
  extract,
  integrity,
  narrate,
  referee,
  type RoleDeps,
} from './roles-pg.ts';
import type { ValidationResult } from './validate-pg.ts';

/** Per-role output reservations. The narrator needs far more room than the rest. */
const OUTPUT_RESERVE: Record<string, number> = {
  classify: 256,
  integrity: 384,
  referee: 512,
  director: 384,
  narrate: 2048,
  extract: 1536,
};

export interface ProseGate {
  lint(text: string): LintReport;
  /** Optional rewrite when lint trips. Omitted means lint-only. */
  rewrite?: (text: string, report: LintReport) => Promise<string>;
}

export interface EngineOptions {
  world: World | (() => World);
  /**
   * The pool, needed to *start* a transaction.
   *
   * A `World` holds a `Queryable`, which may itself already be a transaction
   * client and cannot begin another — so `commitDelta` needs the pool rather than
   * the world. See `commit-pg.ts` for why every statement in the delta commit has
   * to ride one checked-out client.
   */
  db: Db;
  providers: Registry;
  proseGate?: ProseGate;
  /** Called when the integrity gate stops the turn, before anything is committed. */
  onInterrupt?: (interrupt: Interrupt) => void;
  /** Scenes per chapter for automatic compaction. */
  chapterSize?: number;
  /** Disable automatic compaction on scene advance. */
  autoCompact?: boolean;
}

export type TurnOutcome =
  | { kind: 'narrated'; turn: Turn; prose: string; delta: Delta; commit: CommitResult; validation: ValidationResult }
  | { kind: 'interrupted'; interrupt: Interrupt; distance: string; reasoning: string }
  | { kind: 'blocked'; reason: string; validation: ValidationResult }
  | { kind: 'answered'; text: string }
  /**
   * Everything through Direct ran and agreed on a beat, but no Narrator role
   * wrote it — `narrateExternally` was set. `resumeToken` identifies the
   * pending state for `Engine.commitExternalNarration`; `system`/`user` are
   * exactly what this engine's own `narrate()` would have sent a provider
   * (see `roles.ts`'s `buildNarratorPrompt`), so an external caller renders
   * from the identical material rather than a paraphrase of it.
   */
  | { kind: 'awaiting-narration'; resumeToken: string; system: string; user: string; maxTokens: number };

export interface TakeTurnOptions {
  /** Set when the player answered an interrupt with 'override' or 'establish-break'. */
  overrideIntegrity?: boolean;
  /** Force the acting character; defaults to the player character. */
  actorId?: EntityId;
  /**
   * Receives narration as it arrives. Only the narrator streams; the mechanical
   * roles return structured output, where a partial result is worthless.
   */
  onToken?: (chunk: string) => void;
  /** Called once the gates have passed, so the UI can stop saying "thinking". */
  onStage?: (stage: string) => void;
  /**
   * Stop after Direct and return `{ kind: 'awaiting-narration' }` instead of
   * calling this engine's own Narrator role. For a caller — the MCP tool
   * path — whose whole point is that the *calling* model writes the prose,
   * at zero cost to this engine's own configured provider. Every gate before
   * Narrate (integrity, referee, director) still runs here, unchanged: the
   * parts of the loop that keep the world consistent are not optional just
   * because prose-writing moved elsewhere.
   */
  narrateExternally?: boolean;
  /**
   * Overrides the captured `getWorld()` for this one call — the seam
   * `src/server/api.ts` uses to run a turn against *this request's own*
   * per-user story (`currentStory.worldFor(user, ...)`) rather than
   * whichever world this `Engine` happened to be constructed with. Omitted
   * means the legacy captured-getter behaviour: every caller from before
   * per-user stories existed keeps working unchanged, including every test
   * in `test/engine.test.ts`.
   */
  world?: World;
}

/**
 * State a turn needs to resume from once external prose comes back —
 * everything computed before Narrate that `commitExternalNarration` would
 * otherwise have to recompute (wasting the calls already made, and risking a
 * second integrity/referee run disagreeing with the first). Kept in-memory,
 * per `Engine` instance: MCP tool calls hit the same long-lived server
 * process this engine already lives in (see `src/mcp/`), so there is no
 * cross-process state to reconstruct, only a short window between "here is
 * the frame" and "here is the prose" within one conversation.
 */
interface PendingNarration {
  storyId: StoryId;
  rawInput: string;
  actorId: EntityId;
  intent: Awaited<ReturnType<typeof classify>>;
  integrityVerdict: IntegrityVerdict | null;
  refereeVerdict: RefereeVerdict;
  plan: DirectorPlan;
  agreedBeat: string;
  overrideIntegrity: boolean;
  calls: TurnMeta['providerCalls'];
  createdAt: number;
}

/** Ten minutes: long enough for a chat client's own model to write a reply, short enough that an abandoned turn does not accumulate forever. */
const PENDING_NARRATION_TTL_MS = 10 * 60 * 1000;

export class Engine {
  /**
   * A getter, not a resolved `World`. `serve.ts` holds one `Engine` for the
   * process lifetime, but which story is "current" can change under it — a
   * save switch, a story switch — without a restart. Capturing a `World` once
   * here would mean every later turn silently keeps playing whichever story
   * was current when the server started; this mirrors the fix already
   * applied to `SetupPlanner` for exactly the same reason, one level up.
   * Resolved once per `takeTurn` call (not per internal step) so a single
   * turn is never split across two different stories mid-flight.
   */
  private getWorld: () => World;
  private db: Db;
  private providers: Registry;
  private proseGate: ProseGate | undefined;
  private onInterrupt: ((i: Interrupt) => void) | undefined;
  private compactor: Compactor;
  private autoCompact: boolean;
  /** Frames from the last turn, for the "why?" panel. */
  lastFrames: Record<string, Frame> = {};
  /** See `PendingNarration`. Keyed by `resumeToken`, a random id — not the turn's own eventual id, which does not exist until commit. */
  private pending = new Map<string, PendingNarration>();


  constructor(opts: EngineOptions) {
    this.getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;
    this.db = opts.db;
    this.providers = opts.providers;
    this.proseGate = opts.proseGate;
    this.onInterrupt = opts.onInterrupt;
    this.autoCompact = opts.autoCompact !== false;
    this.compactor = new Compactor({
      world: this.getWorld,
      provider: opts.providers.get('summarize'),
      ...(opts.chapterSize === undefined ? {} : { chapterSize: opts.chapterSize }),
    });
  }

  /** Exposed so the CLI and API can compact on demand. */
  compaction(): Compactor {
    return this.compactor;
  }

  /** True mid-turn: a save or story switch should wait rather than race a commit. */
  busy = false;

  /**
   * The role dependency bundle for one turn.
   *
   * `session` and `data` are passed in rather than read here, because a turn must
   * see one consistent world: if each role re-read the session, a scene advance
   * committed by a concurrent request would land halfway through and the Narrator
   * would render against a different scene than the Referee adjudicated.
   */
  private deps(
    world: World,
    session: SessionState,
    data: FrameData,
    calls: TurnMeta['providerCalls'],
  ): RoleDeps {
    const providers = this.providers;
    return {
      world,
      data,
      provider: (role) => providers.get(role),
      ctx: (role, extra) => this.frameContext(world, session, role, providers.get(role), extra),
      log: (role, provider, model, tokensIn, tokensOut) => {
        calls.push({ role, provider, model, tokensIn, tokensOut });
      },
    };
  }

  private frameContext(
    world: World,
    session: SessionState,
    role: string,
    provider: Provider,
    extra?: Partial<FrameContext>,
  ): FrameContext {
    const caps = provider.capabilities;
    const reserve = OUTPUT_RESERVE[role] ?? 512;
    return {
      world,
      session,
      tokenizer: tokenizerFor(caps.charsPerToken),
      budget: inputBudget(caps.contextWindow, reserve),
      ...extra,
    };
  }

  async session(): Promise<SessionState> {
    return this.getWorld().session.get();
  }

  /**
   * One player turn. Returns without committing anything when the integrity gate
   * interrupts, so the player's answer decides what happens.
   *
   * Resolves `world` exactly once, before the first gate, and passes that same
   * reference through every step — a switch requested mid-turn is expected to
   * see `busy` and wait, not race a commit against a story that changed underneath it.
   * `opts.world`, when given, is that resolution — see its own doc comment on
   * `TakeTurnOptions` for why a per-request override exists at all.
   */
  async takeTurn(rawInput: string, opts: TakeTurnOptions = {}): Promise<TurnOutcome> {
    this.busy = true;
    try {
      return await this.takeTurnOn(opts.world ?? this.getWorld(), rawInput, opts);
    } finally {
      this.busy = false;
    }
  }

  private async takeTurnOn(world: World, rawInput: string, opts: TakeTurnOptions): Promise<TurnOutcome> {
    const calls: TurnMeta['providerCalls'] = [];
    // One read of the session and one load of the world snapshot for the whole
    // turn. Every role and every frame below is built from these, so five frames
    // cost one fetch rather than five — see `frame/builders-pg.ts`.
    const session = await world.session.get();
    const data = await loadFrameData(world, session);
    const deps = this.deps(world, session, data, calls);
    const actorId = opts.actorId ?? session.playerCharacterId;

    // 1. CLASSIFY
    opts.onStage?.('reading your input');
    const intent = await classify(deps, rawInput, actorId);

    if (intent.class === 'meta-query') {
      return { kind: 'answered', text: await this.answerMetaQuery(world, session, rawInput) };
    }

    // 2-3. INTEGRITY. Cheapest gate, so it runs first and fails fast.
    let integrityVerdict = null;
    if (intent.class === 'action' || intent.class === 'dialogue') {
      opts.onStage?.('checking it against your character');
      integrityVerdict = await integrity(deps, rawInput, actorId);
      if (integrityVerdict.interrupt && !opts.overrideIntegrity) {
        this.onInterrupt?.(integrityVerdict.interrupt);
        return {
          kind: 'interrupted',
          interrupt: integrityVerdict.interrupt,
          distance: integrityVerdict.distance,
          reasoning: integrityVerdict.reasoning,
        };
      }
    }

    // 4. REFEREE
    opts.onStage?.('checking it against the world');
    const refereeVerdict = await referee(deps, rawInput);
    // Existence checked in one query rather than one per spawned name.
    const spawnIds = refereeVerdict.spawn.map((s) => `${typePrefix(s.type)}:${slug(s.name)}`);
    const existing = spawnIds.length ? await world.graph.getMany(spawnIds) : new Map();
    for (const s of refereeVerdict.spawn) {
      const id = `${typePrefix(s.type)}:${slug(s.name)}`;
      if (!existing.has(id)) {
        await world.graph.upsert(
          {
            id,
            type: s.type,
            name: s.name,
            summary: s.summary,
            provenance: `emergent:${session.scene}`,
            createdScene: session.scene,
            salience: 0.6,
          },
          'chronicle',
        );
      }
    }

    // 5. DIRECT
    opts.onStage?.('deciding what happens');
    const plan = await direct(deps, rawInput);

    // The agreed beat is the boundary: everything below this line renders, it
    // does not decide. Passing resistance in as narration guidance is how the
    // 'stretch' tier stays in-fiction instead of becoming a system message.
    const agreedBeat = [
      `ruling: ${refereeVerdict.ruling}${refereeVerdict.cost ? ` (cost: ${refereeVerdict.cost})` : ''}`,
      refereeVerdict.reasoning && `referee: ${refereeVerdict.reasoning}`,
      `gm move: ${plan.move}`,
      `beat: ${plan.beat}`,
      integrityVerdict && integrityVerdict.distance === 'stretch'
        ? `The act is a stretch for this character. Show them feeling the weight of it in the prose; do not stop them.`
        : '',
      integrityVerdict && integrityVerdict.distance === 'off-key'
        ? `This sits badly with who they are. Give the world or their own body some resistance, in fiction.`
        : '',
      opts.overrideIntegrity ? `The author has deliberately broken this character's vow. Play the fallout straight.` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // 6. NARRATE
    if (opts.narrateExternally) {
      opts.onStage?.('awaiting narration');
      const resumeToken = randomUUID();
      this.pending.set(resumeToken, {
        storyId: world.storyId,
        rawInput,
        actorId,
        intent,
        integrityVerdict,
        refereeVerdict,
        plan,
        agreedBeat,
        overrideIntegrity: opts.overrideIntegrity ?? false,
        calls,
        createdAt: Date.now(),
      });
      this.sweepExpiredPending();
      const { system, user, maxTokens } = buildNarratorPrompt(deps, rawInput, agreedBeat, intent.verbatim);
      return { kind: 'awaiting-narration', resumeToken, system, user, maxTokens };
    }

    opts.onStage?.('writing');
    const prose = await narrate(deps, rawInput, agreedBeat, intent.verbatim, opts.onToken);

    return this.finishTurn({
      world,
      session,
      rawInput,
      actorId,
      intent,
      integrityVerdict,
      refereeVerdict,
      plan,
      overrideIntegrity: opts.overrideIntegrity ?? false,
      prose,
      calls,
      deps,
      onStage: opts.onStage,
    });
  }

  /**
   * Steps 6b–9, shared by the normal in-process path (`takeTurnOn`, prose
   * from this engine's own Narrator role) and the external-narration resume
   * path (`commitExternalNarration`, prose from whatever wrote it on the
   * other end of an MCP tool call). One implementation, so a future change
   * to the prose gate or the commit sequence cannot apply to one path and
   * not the other by accident.
   */
  private async finishTurn(args: {
    world: World;
    session: SessionState;
    rawInput: string;
    actorId: EntityId;
    intent: Awaited<ReturnType<typeof classify>>;
    integrityVerdict: IntegrityVerdict | null;
    refereeVerdict: RefereeVerdict;
    plan: DirectorPlan;
    overrideIntegrity: boolean;
    prose: string;
    calls: TurnMeta['providerCalls'];
    deps: RoleDeps;
    onStage?: (stage: string) => void;
  }): Promise<TurnOutcome> {
    const { world, session, rawInput, actorId, intent, integrityVerdict, refereeVerdict, plan, overrideIntegrity, deps } =
      args;
    let prose = args.prose;

    // 6b. PROSE GATE. Deterministic lint first; the model only runs if it trips.
    let lint: LintReport | null = null;
    if (this.proseGate) {
      lint = this.proseGate.lint(prose);
      if (lint.tripped && this.proseGate.rewrite) {
        prose = await this.proseGate.rewrite(prose, lint);
        lint = this.proseGate.lint(prose);
      }
    }

    // 7-8. EXTRACT + VALIDATE
    args.onStage?.('recording what changed');
    const { delta, validation } = await extract(deps, prose, rawInput);
    if (!validation.ok) {
      // Surfaced, not silently dropped: a discarded delta is how the graph and
      // the prose drift apart.
      return { kind: 'blocked', reason: 'delta failed validation', validation };
    }

    // A vow break the player authorised must be recorded even if extraction
    // missed it, or the most consequential beat in the story vanishes.
    if (overrideIntegrity && integrityVerdict?.violatedVows.length) {
      for (const vowId of integrityVerdict.violatedVows) {
        if (!delta.vowBreaks.some((v) => v.vowId === vowId)) {
          delta.vowBreaks.push({ entityId: actorId, vowId });
        }
      }
    }

    // 9. COMMIT
    const commit = await commitDelta(this.db, world, delta);

    // Compaction runs after the commit, on the scene that just closed: only the
    // current scene stays verbatim, everything above it becomes a summary.
    if (this.autoCompact && delta.sceneAdvance) {
      await this.compactor.onSceneClosed(session.scene);
    }

    const meta: TurnMeta = {
      integrity: integrityVerdict,
      referee: refereeVerdict,
      move: plan.move,
      frameLog: this.lastFrames.narrate?.log ?? null,
      lint,
      providerCalls: args.calls,
    };

    const turnNo = session.turn + 1;
    const turn = await world.chronicle.addTurn({
      scene: session.scene,
      turn: turnNo,
      rawInput,
      intent,
      delta,
      bookProse: prose,
      pinned: false,
      meta,
    });
    await world.session.set({ turn: turnNo });

    if (plan.threadId) await world.threads.adjustTension(plan.threadId, 0.05);

    return { kind: 'narrated', turn, prose, delta, commit, validation };
  }

  /** Expired pending narrations are dropped lazily, on the next write to `pending`, rather than on a timer — no interval to leak if an `Engine` is ever discarded. */
  private sweepExpiredPending(): void {
    const cutoff = Date.now() - PENDING_NARRATION_TTL_MS;
    for (const [token, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(token);
    }
  }

  /**
   * Resumes a turn `takeTurn({ narrateExternally: true })` paused before
   * Narrate, given prose written elsewhere — the MCP tool path's whole
   * point (`src/mcp/tools.ts`). Runs exactly the gates a normal turn would
   * have run *after* Narrate (prose gate, extract, validate, commit); every
   * gate before Narrate already ran when the pending state was recorded, and
   * is not re-run here, both to avoid double-charging those calls and
   * because a second run could legitimately disagree with the first (a
   * non-deterministic model call), which would leave the returned frame and
   * the committed delta reasoning about two different verdicts.
   *
   * Throws on an unknown or expired token rather than returning a
   * `TurnOutcome`, since there is no in-fiction meaning for "your turn
   * vanished" — that is a caller bug (a stale token, a second attempt after
   * the ten-minute window) rather than something a player did.
   *
   * `world` mirrors `TakeTurnOptions.world`: the caller's own resolution of
   * which story this belongs to, which for a per-user MCP connection is that
   * user's story rather than whichever one the shared pointer happens to be
   * on. Without it this resolved through `getWorld()`, so every user whose
   * story was not the current shared one hit the story-changed guard below on
   * commit and lost the turn — the guard firing on an unrelated user's switch
   * rather than on a real mismatch.
   */
  async commitExternalNarration(resumeToken: string, prose: string, worldOverride?: World): Promise<TurnOutcome> {
    const pending = this.pending.get(resumeToken);
    if (!pending) throw new Error(`no pending narration for token ${resumeToken} (expired or already resolved)`);
    this.pending.delete(resumeToken);

    this.busy = true;
    try {
      const world = worldOverride ?? this.getWorld();
      if (world.storyId !== pending.storyId) {
        // The story switched under this pending turn (a save switch mid-
        // conversation). Committing against the wrong story's graph would be
        // silent corruption, not a recoverable error, so this refuses outright.
        throw new Error('the open story changed since this turn was proposed; nothing was committed');
      }
      // The pending turn's own snapshot is reloaded rather than stored: an
      // external narration may have taken minutes, and committing against a
      // stale view of the world would be worse than paying for one more read.
      const session = await world.session.get();
      const data = await loadFrameData(world, session);
      const deps = this.deps(world, session, data, pending.calls);
      return await this.finishTurn({
        world,
        session,
        rawInput: pending.rawInput,
        actorId: pending.actorId,
        intent: pending.intent,
        integrityVerdict: pending.integrityVerdict,
        refereeVerdict: pending.refereeVerdict,
        plan: pending.plan,
        overrideIntegrity: pending.overrideIntegrity,
        prose,
        calls: pending.calls,
        deps,
      });
    } finally {
      this.busy = false;
    }
  }


  /**
   * Re-renders a stored turn's prose through the *current* style contract,
   * without touching what happened (DESIGN §7.2). The delta already committed
   * is the boundary: this replays the narrator alone, against the same beat
   * summary the original turn agreed on, so the graph, events and facts are
   * completely untouched — only `bookProse` changes.
   *
   * Refuses a pinned turn outright rather than silently no-op-ing through
   * `setProse`, so a caller gets a reason instead of a passage that quietly
   * never changed.
   *
   * `note` is an optional steering hint ("shorter", "cut the metaphor") folded
   * into the beat the narrator sees, for the common case of "reroll, but fix
   * this one thing" rather than a blind retry hoping for a better roll.
   */
  async regenerateProse(
    turnId: string,
    opts: { note?: string; onToken?: (chunk: string) => void; world?: World } = {},
  ): Promise<Turn> {
    const world = opts.world ?? this.getWorld();
    const turn = await world.chronicle.getTurn(turnId);
    if (!turn) throw new Error(`no turn ${turnId}`);
    if (turn.pinned) throw new Error('this passage is pinned and will not be re-rendered');

    const calls: TurnMeta['providerCalls'] = [];
    // A reroll re-renders one turn, so it needs the same snapshot machinery as a
    // fresh turn: the narrator frame is built from present cast, location and
    // recent prose exactly as before.
    const session = await world.session.get();
    const data = await loadFrameData(world, session);
    const deps = this.deps(world, session, data, calls);

    const agreedBeat = [
      turn.meta.referee ? `ruling: ${turn.meta.referee.ruling}${turn.meta.referee.cost ? ` (cost: ${turn.meta.referee.cost})` : ''}` : '',
      turn.meta.referee?.reasoning ? `referee: ${turn.meta.referee.reasoning}` : '',
      turn.meta.move ? `gm move: ${turn.meta.move}` : '',
      turn.delta?.events.length ? `beat: ${turn.delta.events.map((e) => e.text).join(' ')}` : 'beat: continue',
      turn.meta.integrity?.distance === 'stretch'
        ? `The act is a stretch for this character. Show them feeling the weight of it in the prose; do not stop them.`
        : '',
      turn.meta.integrity?.distance === 'off-key'
        ? `This sits badly with who they are. Give the world or their own body some resistance, in fiction.`
        : '',
      opts.note ? `The author asked for this on the reroll: ${opts.note}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // The original turn's own verbatim decision doesn't apply to a reroll:
    // the player isn't retyping their input, so there is nothing of theirs to
    // preserve word-for-word here.
    const prose = await narrate(deps, turn.rawInput, agreedBeat, false, opts.onToken);

    let lint: LintReport | null = turn.meta.lint;
    let finalProse = prose;
    if (this.proseGate) {
      lint = this.proseGate.lint(finalProse);
      if (lint.tripped && this.proseGate.rewrite) {
        finalProse = await this.proseGate.rewrite(finalProse, lint);
        lint = this.proseGate.lint(finalProse);
      }
    }

    await world.chronicle.setProse(turnId, finalProse);
    await world.chronicle.appendRerollMeta(turnId, { providerCalls: calls, lint });

    return (await world.chronicle.getTurn(turnId))!;
  }

  /** Answers a world question from state without advancing the story. */
  private async answerMetaQuery(world: World, session: SessionState, q: string): Promise<string> {
    const words = q.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    // Searches run together: they are independent and go through the pool, so the
    // whole set costs about one round trip rather than one each.
    const hits = (await Promise.all(words.map((w) => world.graph.search(w, 3)))).flat();
    if (!hits.length) return 'Nothing in the record speaks to that yet.';

    // Dedupe by id, keeping first-seen order. A plain loop rather than a filter
    // with a side effect in it: the searches can return the same entity for
    // several words, and hiding the mutation inside a predicate is exactly the
    // sort of cleverness that reads wrong later.
    const seen = new Set<string>();
    const unique: typeof hits = [];
    for (const e of hits) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      unique.push(e);
      if (unique.length === 4) break;
    }
    // Neighbourhoods and the names they mention, in two batched queries instead of
    // one edge read plus one name lookup per hit.
    const neighbourhoods = await world.graph.neighboursMany(unique.map((e) => e.id), session.scene);
    const objectIds = [...neighbourhoods.values()].flat().map((n) => n.edge.object);
    const names = await world.graph.getMany(objectIds);

    const lines = unique.map((e) => {
      const rel = (neighbourhoods.get(e.id) ?? [])
        .filter((n) => n.edge.subject === e.id)
        .slice(0, 4)
        .map((n) => `${n.edge.predicate.toLowerCase().replace(/_/g, ' ')} ${names.get(n.edge.object)?.name ?? n.edge.object}`)
        .join(', ');
      return `${e.name} (${e.type}): ${e.summary || 'no summary'}${rel ? `. ${rel}.` : ''}`;
    });
    return lines.join('\n');
  }
}

function typePrefix(type: string): string {
  switch (type) {
    case 'Character':
      return 'char';
    case 'Location':
      return 'loc';
    case 'Faction':
      return 'fac';
    case 'Item':
      return 'item';
    case 'Event':
      return 'event';
    default:
      return 'concept';
  }
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
