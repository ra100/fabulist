/**
 * Deterministic mock provider.
 *
 * Exists so the entire turn loop is testable with no network and no API keys,
 * and so the provider conformance suite (DESIGN §13) has a fixed baseline. It
 * pattern-matches the prompt rather than generating, which makes it predictable
 * enough to assert on while still exercising every role and every branch —
 * including a vow breach, which is otherwise awkward to trigger on demand.
 */
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderCapabilities,
} from './provider.ts';

/** Small deterministic PRNG so "random" choices are stable across runs. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const VIOLENT = /\b(stab|kill|murder|strike|hit|punch|shoot|slay|stran(gle|gled)|behead|knife|attack|slit)\b/i;
const CHAOS = /\b(for (the )?(lol|lulz|laughs|chaos|fun)|just because|randomly|for no reason)\b/i;
const NEW_PLACE = /\b(tavern|inn|shop|alley|shrine|market|smithy|library)\b/i;

export interface MockOptions {
  id?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Force a specific coherence distance, for tests that need one branch. */
  forceDistance?: string;
}

export class MockProvider implements Provider {
  readonly id: string;
  readonly model = 'mock-1';
  readonly capabilities: ProviderCapabilities;
  private forceDistance: string | undefined;
  /** Call log, so tests can assert which roles ran and with what budget. */
  readonly calls: Array<{ role: string; chars: number }> = [];

  constructor(opts: MockOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.forceDistance = opts.forceDistance;
    this.capabilities = {
      contextWindow: 64_000,
      structuredOutput: 'native-schema',
      systemRole: true,
      streaming: false,
      costTier: 'free',
      charsPerToken: 4,
      proseQuality: 0.5,
      steerability: 0.9,
      ...opts.capabilities,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const prompt = req.messages.map((m) => m.content).join('\n');
    this.calls.push({ role: req.role, chars: prompt.length });

    // The player's raw input is fenced in the prompt by the roles that need it.
    const input = prompt.match(/<player-input>([\s\S]*?)<\/player-input>/)?.[1]?.trim() ?? '';
    const text = this.respond(req.role, input, prompt);

    return {
      text,
      tokensIn: Math.ceil(prompt.length / this.capabilities.charsPerToken),
      tokensOut: Math.ceil(text.length / this.capabilities.charsPerToken),
      model: this.model,
      schemaEnforced: this.capabilities.structuredOutput === 'native-schema' && !!req.schema,
    };
  }

  private respond(role: string, input: string, prompt: string): string {
    switch (role) {
      case 'classify':
        return this.classify(input);
      case 'integrity':
        return this.integrity(input, prompt);
      case 'referee':
        return this.referee(input);
      case 'director':
        return this.director(prompt);
      case 'narrate':
        return this.narrate(input, prompt);
      case 'extract':
        return this.extract(input, prompt);
      case 'humanize':
        return this.humanize(prompt);
      case 'passb':
        return this.passB(prompt);
      case 'summarize':
        return this.summarize(prompt);
      default:
        return JSON.stringify({ ok: true });
    }
  }

  private classify(input: string): string {
    const isOoc = /^\s*(ooc|\/\/|note:)/i.test(input);
    const isQuestion = /\?\s*$/.test(input) && /\b(what|who|where|when|why|how)\b/i.test(input);
    const hasQuote = /["']/.test(input) || /\b(say|tell|ask|whisper|shout)\b/i.test(input);
    const cls = isOoc ? 'ooc-directive' : isQuestion ? 'meta-query' : hasQuote ? 'dialogue' : 'action';
    // Polished prose should survive verbatim rather than being re-rendered.
    const verbatim = /^[A-Z]/.test(input.trim()) && /[.!?]$/.test(input.trim()) && input.length > 60;
    return JSON.stringify({
      class: cls,
      action: input.slice(0, 120) || 'wait',
      manner: VIOLENT.test(input) ? 'violent' : 'measured',
      targetNames: [],
      dialogueGist: hasQuote ? input.slice(0, 80) : null,
      verbatim,
    });
  }

  private integrity(input: string, prompt: string): string {
    if (this.forceDistance) {
      return JSON.stringify({
        distance: this.forceDistance,
        violatedVowIds: this.forceDistance === 'contract-breach' ? ['nonviolence'] : [],
        reasoning: 'forced by test',
      });
    }
    const vowsBlock = prompt.match(/<vows>([\s\S]*?)<\/vows>/)?.[1] ?? '';
    const hasNonviolence = /nonviolence|harm no|shed no blood/i.test(vowsBlock);
    const violent = VIOLENT.test(input);

    if (violent && hasNonviolence) {
      const vowId = vowsBlock.match(/id=([a-z0-9-]+)/i)?.[1] ?? 'nonviolence';
      return JSON.stringify({
        distance: CHAOS.test(input) ? 'incoherent' : 'contract-breach',
        violatedVowIds: [vowId],
        reasoning: 'The action violates a ranked vow and nothing in the scene compels it.',
      });
    }
    if (violent) {
      return JSON.stringify({ distance: 'stretch', violatedVowIds: [], reasoning: 'Violence is available but costly.' });
    }
    return JSON.stringify({ distance: 'in-character', violatedVowIds: [], reasoning: 'Consistent with the sheet.' });
  }

  private referee(input: string): string {
    const match = input.match(NEW_PLACE);
    if (match) {
      const name = match[0]!;
      return JSON.stringify({
        ruling: 'allow',
        reasoning: 'Consistent with the neighbourhood; canonising it.',
        cost: null,
        spawn: [{ type: 'Location', name: name[0]!.toUpperCase() + name.slice(1), summary: `A ${name} nearby.` }],
      });
    }
    if (/\b(fly|teleport|resurrect|immortal)\b/i.test(input)) {
      return JSON.stringify({
        ruling: 'friction',
        reasoning: 'The world does not work that way here.',
        cost: 'the attempt draws attention',
        spawn: [],
      });
    }
    return JSON.stringify({ ruling: 'allow', reasoning: 'Nothing contradicts state.', cost: null, spawn: [] });
  }

  private director(prompt: string): string {
    const moves = [
      'reveal an unwelcome truth',
      'offer an opportunity, with a cost',
      'put someone in a spot',
      'use up their resources',
      'turn their own move against them',
      'announce off-screen badness',
      'have an NPC act on their own agenda',
      'make the world push back physically',
    ];
    const threadId = prompt.match(/<threads>[\s\S]*?id=([a-z0-9:-]+)/i)?.[1] ?? null;
    const move = moves[hash(prompt) % moves.length]!;
    return JSON.stringify({
      move,
      threadId,
      beat: 'escalate',
      reasoning: 'Highest-tension thread has an opening here.',
    });
  }

  private narrate(input: string, prompt: string): string {
    const pov = prompt.match(/pov:\s*(\S+)/)?.[1] ?? 'third-limited';
    const who = prompt.match(/<present-cast>[\s\S]*?name=([^\n<]+)/)?.[1]?.trim() ?? 'he';
    const subject = pov === 'first' ? 'I' : who;
    const gist = input.replace(/\s+/g, ' ').slice(0, 90) || 'waited';
    // Deliberately plain. Prose quality is not what the mock is for.
    return [
      `${subject} moved as intended: ${gist}.`,
      `The room took it in without comment, and the moment passed into whatever came next.`,
    ].join(' ');
  }

  private extract(input: string, prompt: string): string {
    const actor = prompt.match(/<actor>([^<]+)<\/actor>/)?.[1]?.trim() ?? 'char:unknown';
    const location = prompt.match(/<location>([^<]+)<\/location>/)?.[1]?.trim() || null;
    const significance = VIOLENT.test(input) ? 0.9 : 0.4;
    return JSON.stringify({
      events: [
        {
          text: input.slice(0, 160) || 'A quiet beat passed.',
          participants: [actor],
          locationId: location,
          significance,
        },
      ],
      entityUpserts: [],
      edgeAsserts: [],
      edgeRetires: [],
      conditionUpdates: [{ entityId: actor, patch: { intent: input.slice(0, 60) } }],
      relationshipUpdates: [],
      factsLearned: [],
      threadUpdates: [],
      vowBreaks: [],
      sceneAdvance: false,
    });
  }

  private humanize(prompt: string): string {
    const draft = prompt.match(/<draft>([\s\S]*?)<\/draft>/)?.[1] ?? '';
    // Strip the tells the deterministic linter flags, so the repair path is exercised.
    return draft
      .replace(/\s*—\s*/g, ', ')
      .replace(/\b(a )?(testament|tapestry) (to|of)\b/gi, 'a result of')
      .replace(/\bit'?s not just ([^,;.]+)[,;] it'?s\b/gi, '$1 is')
      .replace(/\b(let out|released) a breath (he|she|they) didn'?t know (he|she|they) w(as|ere) holding\b/gi, 'exhaled')
      .trim();
  }

  /**
   * Pass B. Quotes real sentences out of the supplied page so the evidence
   * verifier passes on the honest relations, and deliberately emits three bad
   * ones — an unquotable evidence span, an off-vocabulary predicate, and an
   * object that does not exist — so every rejection path is exercised.
   */
  private passB(prompt: string): string {
    const page = prompt.match(/<page>([\s\S]*?)<\/page>/)?.[1] ?? '';
    const subject = prompt.match(/<subject>([^<(]+)/)?.[1]?.trim() ?? '';
    const known = (prompt.match(/<known-entities>([\s\S]*?)<\/known-entities>/)?.[1] ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const sentences = page
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 25);

    const relations: Array<Record<string, unknown>> = [];
    // One well-evidenced relation per named entity actually mentioned in a
    // sentence, which is what a competent extractor would return.
    for (const name of known) {
      if (relations.length >= 3) break;
      if (name === subject) continue;
      const hit = sentences.find((s) => s.includes(name));
      if (!hit) continue;
      relations.push({
        predicate: /brother|sister|father|mother/.test(hit) ? 'KIN_OF' : 'ALLIED_WITH',
        object: name,
        evidence: hit.slice(0, 220),
        weight: 0.7,
      });
    }

    relations.push(
      { predicate: 'ALLIED_WITH', object: known[0] ?? 'Nobody', evidence: 'a sentence that is not on the page at all', weight: 0.9 },
      { predicate: 'FEELS_VAGUELY_ABOUT', object: known[0] ?? 'Nobody', evidence: sentences[0] ?? 'x', weight: 0.5 },
      { predicate: 'HOSTILE_TO', object: 'An Entity That Does Not Exist', evidence: sentences[0] ?? 'x', weight: 0.8 },
    );

    const quoted = [...page.matchAll(/"([^"\n]{12,200})"/g)].map((m) => m[1]!);

    return JSON.stringify({
      relations,
      events: sentences.slice(0, 2).map((s) => ({
        text: s.slice(0, 200),
        inWorldDate: /\b\d{3,4}\s*(AV|BC|AD|BBY|ABY)\b/.exec(s)?.[0] ?? null,
        participants: [subject],
      })),
      voice: quoted.length
        ? { diction: 'terse and concrete', tics: [], samples: [...quoted.slice(0, 3), 'a line never spoken on this page'], never: [] }
        : undefined,
      contradictions: [],
    });
  }

  /** Scene summary. Keeps entity ids intact so summaries stay graph-walkable. */
  private summarize(prompt: string): string {
    // Read ids only from the supplied roster. Scanning the whole prompt would
    // also pick up the example ids in the system instructions, which would let a
    // genuine id-loss bug pass unnoticed.
    const roster = prompt.match(/<entities>([\s\S]*?)<\/entities>/)?.[1] ?? '';
    const ids = [...roster.matchAll(/\b((?:char|loc|fac|item|concept|event):[a-z0-9-]+)/g)].map((m) => m[1]!);
    const unique = [...new Set(ids)].slice(0, 6);
    const body = prompt.match(/<prose>([\s\S]*?)<\/prose>/)?.[1] ?? '';
    const first = body.split(/(?<=[.!?])\s+/).find((s) => s.trim().length > 20)?.trim() ?? 'Little was resolved.';
    return JSON.stringify({
      summary: `${first} ${unique.length ? `Involved: ${unique.join(', ')}.` : ''}`.trim(),
      title: first.split(/[,.]/)[0]?.slice(0, 60) ?? 'A scene',
    });
  }
}
