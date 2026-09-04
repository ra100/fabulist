/**
 * Setup planner. Turns what a player says into something the engine can execute.
 *
 * The point of this file is that "I want to play a minor Toussaint knight around
 * the Blood and Wine story" is a perfectly good instruction that no CLI flag can
 * express. The planner converts it into seed pages, a depth mode, a character
 * sketch and a style contract — then hands back something the player can correct
 * before anything is spent.
 *
 * Everything it produces is a *proposal*. The UI shows it, the player edits it,
 * and only then does ingest run.
 */
import type { StyleContract } from '../domain/types.ts';
import { defaultStyleContract } from '../domain/types.ts';
import { adaptRequest, extractJson, type JsonSchema, type Provider } from '../providers/provider.ts';
import type { WikiCandidate } from './directory.ts';

export const planSchema: JsonSchema = {
  name: 'setup_plan',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['seeds', 'mode', 'reasoning'],
    properties: {
      seeds: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['skim', 'mid', 'deep'] },
      reasoning: { type: 'string' },
      excludeCategories: { type: 'array', items: { type: 'string' } },
      character: {
        type: 'object',
        additionalProperties: false,
        properties: {
          existing: { type: ['string', 'null'] },
          name: { type: 'string' },
          role: { type: 'string' },
          goals: { type: 'array', items: { type: 'string' } },
          vows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'rank'],
              properties: { text: { type: 'string' }, rank: { type: 'number' } },
            },
          },
        },
      },
      style: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pov: { type: 'string' },
          tense: { type: 'string' },
          register: { type: 'string' },
          density: { type: 'string' },
          genreLens: { type: 'string' },
          humor: { type: 'string' },
          pacing: { type: 'string' },
          comparables: { type: 'array', items: { type: 'string' } },
        },
      },
      opening: { type: 'string' },
    },
  },
};

const SYSTEM = `You plan the setup of a role-play session inside an existing fictional
universe. You are given what the player said, the wiki that was resolved, and a
list of real starting points from that wiki.

Produce a plan, not prose.

Seeds: choose 2 to 6 page titles from the supplied starting points. Prefer the
narrowest set that covers where the player wants to play — an arc, a region, a
faction, a few central characters. Do not invent titles that were not offered.
A tight scope produces a better game than a broad one.

Mode: skim for a light visit or a wide unfamiliar universe, mid for an actual
campaign, deep only if the player signalled they will live here for months.

Character: if the player named an existing character, put their name in
"existing". Otherwise sketch an original one who fits the setting, and give them
two or three ranked vows. Vows are what let the game master say "they would not
do that", so make them concrete and breakable, not vague virtues. Rank 1 is the
most inviolable.

Style: infer from how the player talks about what they want. If they named books
or films, put those in comparables — naming a work carries more signal than any
adjective.

Opening: one sentence describing where the first scene should start. Somewhere
with immediate pressure, not a tavern at rest.

Reply with JSON only.`;

const CUSTOM_SYSTEM = `You design a small original world for a role-play session from the
player's description.

Produce between 12 and 20 entities: a handful of locations, two or three
factions with conflicting agendas, and six to ten characters. Give the world one
central tension that is already under strain when play begins.

Rules:
- ids must be of the form char:kebab-name, loc:kebab-name, fac:kebab-name,
  item:kebab-name, concept:kebab-name
- every relation must use ids you defined
- the player character needs ranked vows: concrete, breakable commitments that a
  game master could refuse an action against
- give two or three open threads, each with several possible resolutions, never
  one. A single path is a plot, and a plot breaks the moment the player deviates
- relationships are directional and may be asymmetric; that is normal, not an
  edge case

Reply with JSON only.`;

export const customWorldSchema: JsonSchema = {
  name: 'custom_world',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['entities', 'playerCharacterId'],
    properties: {
      title: { type: 'string' },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'type', 'name', 'summary'],
          properties: {
            id: { type: 'string' },
            type: { type: 'string' },
            name: { type: 'string' },
            summary: { type: 'string' },
          },
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['subject', 'predicate', 'object'],
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
            weight: { type: 'number' },
          },
        },
      },
      playerCharacterId: { type: 'string' },
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['entityId'],
          properties: {
            entityId: { type: 'string' },
            goals: { type: 'array', items: { type: 'string' } },
            fears: { type: 'array', items: { type: 'string' } },
            secrets: { type: 'array', items: { type: 'string' } },
            diction: { type: 'string' },
            locationId: { type: ['string', 'null'] },
            vows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'rank'],
                properties: { text: { type: 'string' }, rank: { type: 'number' } },
              },
            },
          },
        },
      },
      relationships: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fromId', 'toId'],
          properties: {
            fromId: { type: 'string' },
            toId: { type: 'string' },
            trust: { type: 'number' },
            affection: { type: 'number' },
            respect: { type: 'number' },
            note: { type: 'string' },
          },
        },
      },
      threads: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: {
            title: { type: 'string' },
            stakes: { type: 'string' },
            tension: { type: 'number' },
            parties: { type: 'array', items: { type: 'string' } },
            resolutions: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string' },
            knownBy: { type: 'array', items: { type: 'string' } },
            suspectedBy: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      opening: { type: 'string' },
    },
  },
};

export interface PlanRequest {
  /** What the player typed. */
  wish: string;
  wiki: WikiCandidate;
  startingPoints: Array<{ title: string; kind: string; members: number }>;
}

export interface CharacterSketch {
  existing: string | null;
  name: string;
  role: string;
  goals: string[];
  vows: Array<{ text: string; rank: number }>;
}

export interface IngestPlan {
  seeds: string[];
  mode: 'skim' | 'mid' | 'deep';
  reasoning: string;
  excludeCategories: string[];
  character: CharacterSketch;
  style: StyleContract;
  opening: string;
}

export class SetupPlanner {
  private provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  async plan(req: PlanRequest): Promise<IngestPlan> {
    const offered = req.startingPoints
      .map((s) => `${s.kind === 'category' ? 'category' : 'page'}: ${s.title}${s.members ? ` (${s.members} pages)` : ''}`)
      .join('\n');

    const user = [
      `<player-wish>\n${req.wish}\n</player-wish>`,
      `<wiki>${req.wiki.name} — ${req.wiki.articles} articles</wiki>`,
      `<starting-points>\n${offered}\n</starting-points>`,
    ].join('\n\n');

    const raw = (await this.call('setup', SYSTEM, user, planSchema)) as Record<string, unknown>;

    // Seeds are constrained to real titles. A hallucinated page title would fail
    // silently at crawl time and leave the player with an empty world.
    const allowed = new Map(req.startingPoints.map((s) => [s.title.toLowerCase(), s.title]));
    const seeds = asArray(raw.seeds)
      .map((s) => allowed.get(String(s).toLowerCase().replace(/^category:/i, '')) ?? null)
      .filter((s): s is string => !!s);

    const mode = (['skim', 'mid', 'deep'] as const).includes(raw.mode as never)
      ? (raw.mode as 'skim' | 'mid' | 'deep')
      : 'mid';

    return {
      // Falling back to the largest offered starting points beats returning
      // nothing when the model picks badly.
      seeds: seeds.length ? [...new Set(seeds)].slice(0, 6) : req.startingPoints.slice(0, 3).map((s) => s.title),
      mode,
      reasoning: String(raw.reasoning ?? ''),
      excludeCategories: asArray(raw.excludeCategories).map(String).slice(0, 10),
      character: this.character(raw.character),
      style: this.style(raw.style),
      opening: String(raw.opening ?? ''),
    };
  }

  /** Builds a whole small world when there is no wiki to draw on. */
  async customWorld(description: string): Promise<Record<string, unknown>> {
    const raw = (await this.call(
      'setup',
      CUSTOM_SYSTEM,
      `<description>\n${description}\n</description>`,
      customWorldSchema,
    )) as Record<string, unknown>;
    return raw;
  }

  private character(value: unknown): CharacterSketch {
    const c = (value ?? {}) as Record<string, unknown>;
    const vows = asArray(c.vows)
      .map((v) => v as Record<string, unknown>)
      .filter((v) => typeof v.text === 'string' && v.text.trim().length > 3)
      .map((v, i) => ({ text: String(v.text).trim(), rank: typeof v.rank === 'number' ? v.rank : i + 1 }))
      .slice(0, 4);

    return {
      existing: typeof c.existing === 'string' && c.existing.trim() ? c.existing.trim() : null,
      name: String(c.name ?? '').trim(),
      role: String(c.role ?? '').trim(),
      goals: asArray(c.goals).map(String).slice(0, 5),
      vows,
    };
  }

  private style(value: unknown): StyleContract {
    const s = (value ?? {}) as Record<string, unknown>;
    const base = defaultStyleContract();
    const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
      typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

    return {
      ...base,
      pov: pick(s.pov, ['first', 'third-limited', 'third-omniscient', 'second'], base.pov),
      tense: pick(s.tense, ['past', 'present'], base.tense),
      register: pick(s.register, ['plain', 'clipped', 'lyrical', 'ornate', 'archaic'], base.register),
      density: pick(s.density, ['sparse', 'balanced', 'rich'], base.density),
      humor: pick(s.humor, ['none', 'dry', 'absurd'], base.humor),
      pacing: pick(s.pacing, ['languid', 'steady', 'breakneck'], base.pacing),
      genreLens: typeof s.genreLens === 'string' && s.genreLens ? s.genreLens : base.genreLens,
      comparables: asArray(s.comparables).map(String).slice(0, 5),
    };
  }

  private async call(role: string, system: string, user: string, schema: JsonSchema): Promise<unknown> {
    const req = adaptRequest(
      {
        role,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        schema,
        temperature: 0.4,
        maxTokens: 3000,
      },
      this.provider.capabilities,
    );
    const res = await this.provider.complete(req);
    return extractJson(res.text);
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
