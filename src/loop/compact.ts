/**
 * Hierarchical compaction. See DESIGN.md §10.
 *
 * `turn → beat → scene → chapter`. Only the current scene stays verbatim;
 * everything above becomes a summary. The non-obvious requirement is that
 * summaries must keep *entity ids* intact, so the graph is still walkable from a
 * summary — otherwise compaction quietly severs the link between the prose
 * history and the world model, and the Referee loses the ability to check
 * anything that happened more than a scene ago.
 */
import type { EntityId } from '../domain/types.ts';
import type { World } from '../store/index.ts';
import { checkpoint } from '../db/db.ts';
import { adaptRequest, extractJson, type JsonSchema, type Provider } from '../providers/provider.ts';

export const summarySchema: JsonSchema = {
  name: 'summary',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary'],
    properties: {
      summary: { type: 'string' },
      title: { type: 'string' },
    },
  },
};

const SCENE_SYSTEM = `You compress a scene of a story into a short summary that another
writer could build on.

Requirements:
- Report what changed: decisions, revelations, arrivals, departures, injuries,
  shifts in who trusts whom. Skip atmosphere and description.
- Preserve every entity id given to you, written exactly as supplied
  (char:some-name, loc:some-place). They are how the summary stays connected to
  the world model.
- Past tense, plain language, no more than four sentences.
- Do not invent anything that is not in the prose.

Also give a short title naming the scene. Reply with JSON only.`;

const CHAPTER_SYSTEM = `You compress several scene summaries into one chapter summary.

Keep the through-line: what the chapter changed about the situation, and which
threads are still open. Preserve entity ids exactly as supplied. Five sentences
at most. Reply with JSON only.`;

export interface CompactorOptions {
  world: World | (() => World);
  provider: Provider;
  /** Scenes per chapter. */
  chapterSize?: number;
  /** Skip summarising a scene with fewer turns than this; nothing to compact. */
  minTurns?: number;
  onError?: (scope: string, err: unknown) => void;
}

export interface CompactionResult {
  scenesSummarised: number[];
  chaptersSummarised: number[];
}

export class Compactor {
  /**
   * A getter, not a resolved `World`. Same reasoning as `SetupPlanner`'s
   * provider getter: `Engine` holds this `Compactor` for the process
   * lifetime, but which story is "current" can change under it (a save
   * switch, a story switch) without a restart. Capturing a `World` once at
   * construction would mean every later compaction call silently keeps
   * writing to whichever story was current when the server started —
   * exactly the bug shape the SetupPlanner fix caught, one level up.
   */
  private getWorld: () => World;
  private provider: Provider;
  private chapterSize: number;
  private minTurns: number;
  private onError: ((scope: string, err: unknown) => void) | undefined;

  constructor(opts: CompactorOptions) {
    this.getWorld = typeof opts.world === 'function' ? opts.world : () => opts.world as World;
    this.provider = opts.provider;
    this.chapterSize = opts.chapterSize ?? 8;
    this.minTurns = opts.minTurns ?? 2;
    this.onError = opts.onError;
  }

  /**
   * Summarises a single scene from its turns. Idempotent: a scene that already
   * has a summary is left alone unless `force` is set, so this is safe to call
   * on every scene advance.
   */
  async summariseScene(scene: number, force = false): Promise<string | null> {
    const world = this.getWorld();
    const existing = world.chronicle.scenes().find((s) => s.scene === scene);
    if (existing?.summary && !force) return existing.summary;

    const turns = world.chronicle.turns({ scene });
    if (turns.length < this.minTurns) return null;

    const prose = turns.map((t) => t.bookProse).filter(Boolean).join('\n\n');
    if (!prose.trim()) return null;

    // Ids are gathered from the committed deltas rather than from the prose,
    // because the delta is the authoritative record of who was involved.
    const ids = new Set<EntityId>();
    for (const turn of turns) {
      for (const ev of turn.delta?.events ?? []) {
        for (const p of ev.participants) ids.add(p);
        if (ev.locationId) ids.add(ev.locationId);
      }
      for (const c of turn.delta?.conditionUpdates ?? []) ids.add(c.entityId);
    }
    const roster = [...ids]
      .map((id) => `${id} = ${world.graph.get(id)?.name ?? id}`)
      .join('\n');

    const events = world.chronicle
      .events({ sinceScene: scene })
      .filter((e) => e.scene === scene)
      .map((e) => `- ${e.text}`)
      .join('\n');

    const user = [
      `<entities>\n${roster}\n</entities>`,
      events ? `<recorded-events>\n${events}\n</recorded-events>` : '',
      `<prose>\n${prose}\n</prose>`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const parsed = await this.call('summarize', SCENE_SYSTEM, user, `scene ${scene}`);
    if (!parsed) return null;

    const summary = this.keepIds(String(parsed.summary ?? '').trim(), [...ids]);
    if (!summary) return null;

    world.chronicle.upsertScene(scene, {
      summary,
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 90) : '',
      chapter: this.chapterOf(scene),
    });
    return summary;
  }

  /** Rolls completed scene summaries into a chapter summary. */
  async summariseChapter(chapter: number, force = false): Promise<string | null> {
    const world = this.getWorld();
    const existing = world.chronicle.chapter(chapter);
    if (existing?.summary && !force) return existing.summary;

    const scenes = world.chronicle.scenes().filter((s) => s.chapter === chapter && s.summary);
    if (scenes.length < 2) return null;

    const user = scenes.map((s) => `scene ${s.scene}${s.title ? ` (${s.title})` : ''}: ${s.summary}`).join('\n');
    const parsed = await this.call('summarize', CHAPTER_SYSTEM, `<prose>\n${user}\n</prose>`, `chapter ${chapter}`);
    if (!parsed) return null;

    const summary = String(parsed.summary ?? '').trim();
    if (!summary) return null;
    world.chronicle.upsertChapter(chapter, {
      summary,
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 90) : '',
    });
    return summary;
  }

  /**
   * Called after a scene advance. Summarises the scene that just closed, and the
   * chapter if that scene completed one.
   */
  async onSceneClosed(closedScene: number): Promise<CompactionResult> {
    const result: CompactionResult = { scenesSummarised: [], chaptersSummarised: [] };

    const summary = await this.summariseScene(closedScene);
    if (summary) result.scenesSummarised.push(closedScene);

    const chapter = this.chapterOf(closedScene);
    if (closedScene % this.chapterSize === 0) {
      const chapterSummary = await this.summariseChapter(chapter);
      if (chapterSummary) result.chaptersSummarised.push(chapter);
    }

    // A scene boundary is the one moment in play that is already a pause, so
    // it is where the WAL gets folded back in. Doing it per turn would put real
    // I/O in front of the player while they wait for prose. See `db.ts`.
    checkpoint(this.getWorld().db);
    return result;
  }

  /** Catches up any scene that closed without being summarised. */
  async backfill(currentScene: number): Promise<CompactionResult> {
    const world = this.getWorld();
    const result: CompactionResult = { scenesSummarised: [], chaptersSummarised: [] };
    const have = new Map(world.chronicle.scenes().map((s) => [s.scene, s.summary]));

    const scenesWithTurns = new Set(world.chronicle.turns({ limit: 5000 }).map((t) => t.scene));
    for (const scene of [...scenesWithTurns].sort((a, b) => a - b)) {
      if (scene >= currentScene) continue; // the current scene stays verbatim
      if (have.get(scene)) continue;
      const summary = await this.summariseScene(scene);
      if (summary) result.scenesSummarised.push(scene);
    }
    return result;
  }

  chapterOf(scene: number): number {
    return Math.floor((scene - 1) / this.chapterSize) + 1;
  }

  private async call(
    role: string,
    system: string,
    user: string,
    scope: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const req = adaptRequest(
        {
          role,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          schema: summarySchema,
          temperature: 0.2,
          maxTokens: 500,
        },
        this.provider.capabilities,
      );
      const res = await this.provider.complete(req);
      return extractJson(res.text) as Record<string, unknown>;
    } catch (err) {
      this.onError?.(scope, err);
      return null;
    }
  }

  /**
   * Appends any entity id the model dropped.
   *
   * Losing an id is the one failure that makes compaction actively harmful: the
   * summary still reads fine, so nothing looks wrong, but the graph is no longer
   * reachable from it and later scenes silently stop seeing that history. Cheap
   * to repair, so repair rather than retry.
   */
  private keepIds(summary: string, ids: EntityId[]): string {
    if (!summary) return summary;
    const missing = ids.filter((id) => !summary.includes(id));
    if (!missing.length) return summary;
    return `${summary} [also present: ${missing.join(', ')}]`;
  }
}
