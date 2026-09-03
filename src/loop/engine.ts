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
  world: World;
  providers: Registry;
  proseGate?: ProseGate;
  /** Called when the integrity gate stops the turn, before anything is committed. */
  onInterrupt?: (interrupt: Interrupt) => void;
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
}

export class Engine {
  private world: World;
  private providers: Registry;
  private proseGate: ProseGate | undefined;
  private onInterrupt: ((i: Interrupt) => void) | undefined;
  /** Frames from the last turn, for the "why?" panel. */
  lastFrames: Record<string, Frame> = {};

  constructor(opts: EngineOptions) {
    this.world = opts.world;
    this.providers = opts.providers;
    this.proseGate = opts.proseGate;
    this.onInterrupt = opts.onInterrupt;
  }

  private deps(calls: TurnMeta['providerCalls']): RoleDeps {
    const world = this.world;
    const providers = this.providers;
    return {
      world,
      provider: (role) => providers.get(role),
      ctx: (role, extra) => this.frameContext(role, providers.get(role), extra),
      log: (role, provider, model, tokensIn, tokensOut) => {
        calls.push({ role, provider, model, tokensIn, tokensOut });
      },
    };
  }

  private frameContext(role: string, provider: Provider, extra?: Partial<FrameContext>): FrameContext {
    const caps = provider.capabilities;
    const reserve = OUTPUT_RESERVE[role] ?? 512;
    return {
      world: this.world,
      session: this.world.session.get(),
      tokenizer: tokenizerFor(caps.charsPerToken),
      budget: inputBudget(caps.contextWindow, reserve),
      ...extra,
    };
  }

  session(): SessionState {
    return this.world.session.get();
  }

  /**
   * One player turn. Returns without committing anything when the integrity gate
   * interrupts, so the player's answer decides what happens.
   */
  async takeTurn(rawInput: string, opts: TakeTurnOptions = {}): Promise<TurnOutcome> {
    const world = this.world;
    const calls: TurnMeta['providerCalls'] = [];
    const deps = this.deps(calls);
    const session = world.session.get();
    const actorId = opts.actorId ?? session.playerCharacterId;

    // 1. CLASSIFY
    const intent = await classify(deps, rawInput, actorId);

    if (intent.class === 'meta-query') {
      return { kind: 'answered', text: this.answerMetaQuery(rawInput) };
    }

    // 2-3. INTEGRITY. Cheapest gate, so it runs first and fails fast.
    let integrityVerdict = null;
    if (intent.class === 'action' || intent.class === 'dialogue') {
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
    let prose = await narrate(deps, rawInput, agreedBeat, intent.verbatim);

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

  /** Answers a world question from state without advancing the story. */
  private answerMetaQuery(q: string): string {
    const world = this.world;
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
