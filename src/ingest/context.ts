import type { DepthMode, IngestLimits } from './depth.ts';

export const INGEST_CONTEXT_META_KEY = 'ingestContext';

/**
 * What a later session needs to continue reading a wiki without asking the
 * player to re-enter the universe, seeds and mode.
 */
export interface IngestContext {
  baseUrl: string;
  mode: DepthMode;
  seeds: string[];
  excludeCategories: string[];
  title: string;
  wikiName: string;
  /**
   * Budget overrides this world was built with. Stored in wire form (`'all'`,
   * never `Infinity`) because this blob is JSON in a `meta` row.
   */
  budgets?: { maxPages?: number | 'all'; hops?: number | 'all'; passBMaxPages?: number | 'all' };
}

export function serializeIngestContext(ctx: IngestContext): string {
  return JSON.stringify(ctx);
}

export function parseIngestContext(raw: string | null | undefined): IngestContext | null {
  if (!raw) return null;
  try {
    const ctx = JSON.parse(raw) as Partial<IngestContext>;
    if (
      typeof ctx.baseUrl !== 'string' ||
      !['skim', 'mid', 'deep', 'all'].includes(String(ctx.mode)) ||
      !Array.isArray(ctx.seeds) ||
      !Array.isArray(ctx.excludeCategories) ||
      typeof ctx.wikiName !== 'string'
    ) {
      return null;
    }
    return {
      baseUrl: ctx.baseUrl,
      mode: ctx.mode as DepthMode,
      seeds: ctx.seeds.filter((s): s is string => typeof s === 'string'),
      excludeCategories: ctx.excludeCategories.filter((s): s is string => typeof s === 'string'),
      title: typeof ctx.title === 'string' ? ctx.title : '',
      wikiName: ctx.wikiName,
      ...(ctx.budgets && typeof ctx.budgets === 'object' ? { budgets: ctx.budgets as IngestContext['budgets'] } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * JIT play deepening always aims for a deep pocket around the active scene.
 * Worlds already ingested at deep/all naturally no-op because their nodes are
 * already at that level.
 */
export function playDeepeningTarget(_ctx: IngestContext): DepthMode {
  return 'deep';
}

export type { IngestLimits };
