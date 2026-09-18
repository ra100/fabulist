import { WikiClient, type FetchLike } from './client.ts';
import { INGEST_CONTEXT_META_KEY, parseIngestContext, playDeepeningTarget } from './context.ts';
import type { DeepeningConfig as SqliteDeepeningConfig } from '../loop/engine.ts';
import type { DeepeningConfig as PgDeepeningConfig } from '../loop/engine-pg.ts';

interface SyncMetaWorld {
  chronicle: { getMeta(key: string, defaultValue?: string): string };
}

interface AsyncMetaWorld {
  chronicle: { getMeta(key: string, defaultValue?: string): Promise<string> };
}

export interface PlayDeepeningOptions {
  fetcher?: FetchLike;
  delayMs?: number;
  predeepenBetweenScenes?: boolean;
  predeepenLimit?: number;
}

function client(baseUrl: string, cache: Map<string, WikiClient>, opts: PlayDeepeningOptions): WikiClient {
  let hit = cache.get(baseUrl);
  if (!hit) {
    hit = new WikiClient({
      baseUrl,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
      delayMs: opts.delayMs ?? (opts.fetcher ? 0 : 200),
    });
    cache.set(baseUrl, hit);
  }
  return hit;
}

function configFor(baseUrl: string, wikiName: string, cache: Map<string, WikiClient>, opts: PlayDeepeningOptions) {
  return {
    client: client(baseUrl, cache, opts),
    target: 'deep' as const,
    wiki: wikiName,
    ...(opts.predeepenBetweenScenes === undefined ? {} : { predeepenBetweenScenes: opts.predeepenBetweenScenes }),
    ...(opts.predeepenLimit === undefined ? {} : { predeepenLimit: opts.predeepenLimit }),
  };
}

export function sqlitePlayDeepeningResolver(opts: PlayDeepeningOptions = {}) {
  const cache = new Map<string, WikiClient>();
  return (world: SyncMetaWorld): SqliteDeepeningConfig | null => {
    const context = parseIngestContext(world.chronicle.getMeta(INGEST_CONTEXT_META_KEY, ''));
    if (!context) return null;
    return { ...configFor(context.baseUrl, context.wikiName, cache, opts), target: playDeepeningTarget(context) };
  };
}

export function pgPlayDeepeningResolver(opts: PlayDeepeningOptions = {}) {
  const cache = new Map<string, WikiClient>();
  return async (world: AsyncMetaWorld): Promise<PgDeepeningConfig | null> => {
    const context = parseIngestContext(await world.chronicle.getMeta(INGEST_CONTEXT_META_KEY, ''));
    if (!context) return null;
    return { ...configFor(context.baseUrl, context.wikiName, cache, opts), target: playDeepeningTarget(context) };
  };
}
