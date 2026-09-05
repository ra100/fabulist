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
import type {
  Delta,
  EntityId,
  Frame,
  Interrupt,
  LintReport,
  SessionState,
  Turn,
  TurnMeta,
} from '../domain/types.ts';
import { inputBudget } from '../frame/budget.ts';
import type { FrameContext } from '../frame/builders.ts';
import { tokenizerFor } from '../frame/tokenizer.ts';
import type { Provider, Registry } from '../providers/provider.ts';
import type { World } from '../store/index.ts';
import { commitDelta, type CommitResult } from './commit.ts';
import { Compactor } from './compact.ts';
import { classify, direct, extract, integrity, narrate, referee, type RoleDeps } from './roles.ts';
import type { ValidationResult } from './validate.ts';

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
  | { kind: 'answered'; text: string };

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
}

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
  private providers: Registry;
  private proseGate: ProseGate | undefined;
  private onInterrupt: ((i: Interrupt) => void) | undefined;
  private compactor: Compactor;
  private autoCompact: boolean;
  /** Frames from the last turn, for the "why?" panel. */
  lastFrames: Record<string, Frame> = {};

  constructor(opts: EngineOptions) {
    this.getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;
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

  private deps(world: World, calls: TurnMeta['providerCalls']): RoleDeps {
    const providers = this.providers;
    return {
      world,
      provider: (role) => providers.get(role),
      ctx: (role, extra) => this.frameContext(world, role, providers.get(role), extra),
      log: (role, provider, model, tokensIn, tokensOut) => {
        calls.push({ role, provider, model, tokensIn, tokensOut });
      },
    };
  }

  private frameContext(world: World, role: string, provider: Provider, extra?: Partial<FrameContext>): FrameContext {
    const caps = provider.capabilities;
    const reserve = OUTPUT_RESERVE[role] ?? 512;
    return {
      world,
      session: world.session.get(),
      tokenizer: tokenizerFor(caps.charsPerToken),
      budget: inputBudget(caps.contextWindow, reserve),
      ...extra,
    };
  }

  session(): SessionState {
    return this.getWorld().session.get();
  }

  /**
   * One player turn. Returns without committing anything when the integrity gate
   * interrupts, so the player's answer decides what happens.
   *
   * Resolves `world` exactly once, before the first gate, and passes that same
   * reference through every step — a switch requested mid-turn is expected to
   * see `busy` and wait, not race a commit against a story that changed underneath it.
   */
  async takeTurn(rawInput: string, opts: TakeTurnOptions = {}): Promise<TurnOutcome> {
    this.busy = true;
    try {
      return await this.takeTurnOn(this.getWorld(), rawInput, opts);
    } finally {
      this.busy = false;
    }
  }

  private async takeTurnOn(world: World, rawInput: string, opts: TakeTurnOptions): Promise<TurnOutcome> {
    const calls: TurnMeta['providerCalls'] = [];
    const deps = this.deps(world, calls);
    const session = world.session.get();
    const actorId = opts.actorId ?? session.playerCharacterId;

    // 1. CLASSIFY
    opts.onStage?.('reading your input');
    const intent = await classify(deps, rawInput, actorId);

    if (intent.class === 'meta-query') {
      return { kind: 'answered', text: this.answerMetaQuery(world, rawInput) };
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
    for (const s of refereeVerdict.spawn) {
      const id = `${typePrefix(s.type)}:${slug(s.name)}`;
      if (!world.graph.has(id)) {
        world.graph.upsert(
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
    opts.onStage?.('writing');
    let prose = await narrate(deps, rawInput, agreedBeat, intent.verbatim, opts.onToken);

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
    opts.onStage?.('recording what changed');
    const { delta, validation } = await extract(deps, prose, rawInput);
    if (!validation.ok) {
      // Surfaced, not silently dropped: a discarded delta is how the graph and
      // the prose drift apart.
      return { kind: 'blocked', reason: 'delta failed validation', validation };
    }

    // A vow break the player authorised must be recorded even if extraction
    // missed it, or the most consequential beat in the story vanishes.
    if (opts.overrideIntegrity && integrityVerdict?.violatedVows.length) {
      for (const vowId of integrityVerdict.violatedVows) {
        if (!delta.vowBreaks.some((v) => v.vowId === vowId)) {
          delta.vowBreaks.push({ entityId: actorId, vowId });
        }
      }
    }

    // 9. COMMIT
    const commit = commitDelta(world, delta);

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
      providerCalls: calls,
    };

    const turnNo = session.turn + 1;
    const turn = world.chronicle.addTurn({
      scene: session.scene,
      turn: turnNo,
      rawInput,
      intent,
      delta,
      bookProse: prose,
      pinned: false,
      meta,
    });
    world.session.set({ turn: turnNo });

    if (plan.threadId) world.threads.adjustTension(plan.threadId, 0.05);

    return { kind: 'narrated', turn, prose, delta, commit, validation };
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
  async regenerateProse(turnId: string, opts: { note?: string; onToken?: (chunk: string) => void } = {}): Promise<Turn> {
    const world = this.getWorld();
    const turn = world.chronicle.getTurn(turnId);
    if (!turn) throw new Error(`no turn ${turnId}`);
    if (turn.pinned) throw new Error('this passage is pinned and will not be re-rendered');

    const calls: TurnMeta['providerCalls'] = [];
    const deps = this.deps(world, calls);

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

    world.chronicle.setProse(turnId, finalProse);
    world.chronicle.appendRerollMeta(turnId, { providerCalls: calls, lint });

    return world.chronicle.getTurn(turnId)!;
  }

  /** Answers a world question from state without advancing the story. */
  private answerMetaQuery(world: World, q: string): string {
    const session = world.session.get();
    const words = q.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    const hits = words.flatMap((w) => world.graph.search(w, 3));
    if (!hits.length) return 'Nothing in the record speaks to that yet.';
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const e of hits) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const edges = world.graph.edgesFrom(e.id, session.scene).slice(0, 4);
      const rel = edges
        .map((x) => `${x.predicate.toLowerCase().replace(/_/g, ' ')} ${world.graph.get(x.object)?.name ?? x.object}`)
        .join(', ');
      lines.push(`${e.name} (${e.type}): ${e.summary || 'no summary'}${rel ? `. ${rel}.` : ''}`);
    }
    return lines.slice(0, 4).join('\n');
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
