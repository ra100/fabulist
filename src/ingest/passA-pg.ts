/**
 * Pass A: structural extraction, no LLM. See DESIGN.md §3.
 *
 * Idempotency strategy: entity ids are deterministic slugs of (type, title), and
 * both `graph.upsert` and `graph.assertEdge` are upserts keyed on those ids. So
 * running Pass A twice updates in place rather than duplicating, which is what
 * makes re-ingest a diff and depth upgrades resumable.
 */
import type { CharacterSheet, DepthLevelValue, EdgeAssert, Entity, EntityType } from '../domain/types.ts';
import { World } from '../store/index-pg.ts';
import type { Db } from '../db/pg.ts';
import { emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../store/cast-pg.ts';
import type { WikiPage } from './client.ts';
import {
  fieldValues,
  firstParagraph,
  inferEntityType,
  parseCategories,
  parseInfobox,
  parseLinks,
  looksRelational,
  parseQuotes,
  RELATION_FIELDS,
  slugId,
} from './parse.ts';

export interface PassAResult {
  entities: number;
  edges: number;
  sheets: number;
  mentions: number;
  skipped: string[];
  /** Titles where a secondary source's material was kept alongside, not over, existing canon. */
  deferredToCanon: string[];
  /**
   * Infobox field names that look like they carry a relation but matched no
   * rule in `RELATION_FIELDS`, most frequent first. Surfaced so a wiki whose
   * vocabulary this pass does not understand says so — see `looksRelational`.
   */
  unmatchedRelationFields: Array<{ field: string; count: number }>;
}

export interface PassAOptions {
  /** The mode's level: the *deepest* any page in this batch may be recorded at. */
  depth?: DepthLevelValue;
  /**
   * Per-page depth, keyed by page title — the crawl's own hop distance,
   * translated into a level by the caller.
   *
   * Without this every entity in a batch was stamped with the mode's level, so
   * a real ingest ended up with all 11,680 entities at level 3 and depth
   * tiering — the thing `upgradeDepth`, `belowDepth`, `promoteRegion` and
   * `deepenOnDemand` all exist to act on — could not discriminate between the
   * seed you are playing in and a page four hops away. DESIGN.md §3.1's
   * "depth is a property of each subgraph, not one global setting" was true of
   * the modes and false of the data.
   *
   * Falls back to `depth` for any title not in the map.
   */
  depthByTitle?: Map<string, DepthLevelValue>;
  wiki?: string;
  /** Record raw wikilinks as low-weight MENTIONS edges. */
  recordMentions?: boolean;
  /** Mine quoted dialogue into voice cards (mid depth and above). */
  voiceCards?: boolean;
  /**
   * Reported while the batch is being written, so a caller running this inside
   * a job can show real progress. Unlike the crawl, this stage has an exact
   * total from the first line — `pages.length` is known before any work starts
   * — so it is the one phase of an ingest that can honestly show a percentage.
   *
   * Called on a stride rather than per page (see `PASS_A_PROGRESS_STRIDE`):
   * indexing one page is microseconds, and a callback per page would cost more
   * than the work it reports on when the batch is 60,000 pages.
   */
  onProgress?: (done: number, total: number, phase: 'parsing' | 'writing') => void;
  /**
   * Marks this ingest as a lower-priority source relative to whatever is
   * already in canon — the "canon-first" merge policy for ingesting more
   * than one wiki into the same world. Two wikis sharing a fictional universe
   * (Memory Alpha and Memory Beta both being Star Trek, say) routinely share
   * thousands of titles for the same characters and places, each telling it
   * slightly differently; without this, whichever wiki happened to be
   * ingested second would silently overwrite the first entity-for-entity via
   * `graph.upsert`'s ON CONFLICT (name, summary, props all replaced).
   *
   * With `secondary: true`, an id that already resolves to a canon entity
   * from a *different* wiki's provenance keeps that entity's name, summary,
   * type and props; this page only adds props keys canon does not already
   * have, and a diverging summary is kept as a `multi-source` divergence
   * rather than discarded. An id with no existing entity (this wiki alone
   * covers that title) ingests normally — "secondary" is about collisions,
   * not about this source's material being second-class everywhere.
   */
  secondary?: boolean;
}

interface Prepared {
  id: string;
  type: EntityType;
  title: string;
  page: WikiPage;
  categories: string[];
  infobox: ReturnType<typeof parseInfobox>;
  summary: string;
  links: string[];
}

/**
 * How often `onProgress` fires, in pages. Small enough that a UI polling every
 * 700ms always has a fresh number even on a fast local dump, large enough that
 * the callback is noise next to the parsing itself.
 */
export const PASS_A_PROGRESS_STRIDE = 100;

/**
 * Pass A on Postgres: accumulate, then flush in batches.
 *
 * The single most important change in this file. Pass A is the bulk writer of the
 * whole system — the real Star Trek ingest produced 33,332 entities, 152,456 edges
 * and 1,091 sheets from 6,000 pages — and it wrote each of those with its own
 * `upsert`/`assertEdge`/`put` call. In-process that was microseconds each; over a
 * connection it is one round trip each, which would make a wiki ingest take hours
 * of pure latency.
 *
 * So every write is collected into an array and flushed through `upsertMany`,
 * `assertEdgesMany` and `putMany`. The *decisions* are unchanged — same
 * secondary-source merge policy, same predicate rules, same sheet seeding — only
 * the moment of writing moved.
 *
 * Everything runs in one transaction: a half-ingested world is worse than none,
 * and it also means the batches commit together rather than leaving canon visibly
 * half-built to a concurrent reader.
 */
export async function runPassA(db: Db, world: World, pages: WikiPage[], opts: PassAOptions = {}): Promise<PassAResult> {
  const depth = opts.depth ?? 1;
  const depthFor = (title: string): DepthLevelValue => opts.depthByTitle?.get(title) ?? depth;
  const wiki = opts.wiki ?? 'wiki';
  const result: PassAResult = { entities: 0, edges: 0, sheets: 0, mentions: 0, skipped: [], deferredToCanon: [], unmatchedRelationFields: [] };

  // Accumulated, then flushed. See this function's header for why.
  const entityWrites: Array<Partial<Entity> & { id: string; type: EntityType; name: string }> = [];
  const edgeWrites: EdgeAssert[] = [];
  const sheetWrites: CharacterSheet[] = [];
  const divergenceWrites: Array<{ detail: string; canon: string }> = [];
  const pageWrites: Array<{ pageId: string; title: string; revision: string; depth: number }> = [];
  // Each phase reports against its own total: the writing loop iterates the
  // pages that survived parsing, so counting it against `pages.length` would
  // leave the bar short of 100% by however many pages were skipped.
  const report = (done: number, total: number, phase: 'parsing' | 'writing') => {
    if (!opts.onProgress) return;
    if (done % PASS_A_PROGRESS_STRIDE === 0 || done === total) opts.onProgress(done, total, phase);
  };

  // First pass: decide every id before writing edges, so a relation to a page in
  // this batch resolves rather than dangling.
  const prepared: Prepared[] = [];
  const byTitle = new Map<string, Prepared>();

  let parsed = 0;
  for (const page of pages) {
    parsed++;
    report(parsed, pages.length, 'parsing');
    if (!page.wikitext || page.wikitext.trim().length < 20) {
      result.skipped.push(page.title);
      continue;
    }
    const categories = page.categories.length ? page.categories : parseCategories(page.wikitext);
    let infobox: ReturnType<typeof parseInfobox> = null;
    let summary = '';
    // A malformed page must not take down the batch.
    try {
      infobox = parseInfobox(page.wikitext);
      summary = firstParagraph(page.wikitext);
    } catch {
      result.skipped.push(page.title);
      continue;
    }
    const type = inferEntityType(page.title, categories, infobox, summary);
    const entry: Prepared = {
      id: slugId(type, page.title),
      type,
      title: page.title,
      page,
      categories,
      infobox,
      summary,
      links: page.links.length ? page.links : parseLinks(page.wikitext),
    };
    prepared.push(entry);
    byTitle.set(page.title.toLowerCase(), entry);
  }

  // What is already in canon, fetched in one batch each rather than one query per
  // page inside the loops below.
  //
  // `getCanon` was called per page for the secondary-source merge, and `cast.get`
  // per character for sheet seeding. On a 6,000-page ingest that is thousands of
  // round trips before a single row is written.
  const preparedIds = prepared.map((p) => p.id);
  const existingCanonById = opts.secondary
    ? new Map(
        (await world.graph.list({ layer: 'canon', limit: 100_000 }))
          .filter((e) => preparedIds.includes(e.id))
          .map((e) => [e.id, e]),
      )
    : new Map<string, Entity>();
  const characterIds = prepared.filter((p) => p.type === 'Character').map((p) => p.id);
  const existingSheetById = characterIds.length
    ? await world.cast.getManyOrBlank(characterIds)
    : new Map<string, CharacterSheet>();

  // Names this batch does not contain, resolved once before the edge loops. The
  // mention pass alone calls `resolve` for every wikilink on every page.
  const localTitles = new Set(byTitle.keys());
  const externalNames = new Set<string>();
  for (const p of prepared) {
    if (p.infobox) {
      for (const [field, value] of Object.entries(p.infobox.fields)) {
        if (!RELATION_FIELDS.some((r) => r.field.test(field))) continue;
        for (const raw of fieldValues(value)) {
          const key = raw.trim().toLowerCase();
          if (key && !localTitles.has(key)) externalNames.add(raw.trim());
        }
      }
    }
    if (opts.recordMentions !== false) {
      for (const link of p.links) {
        const key = link.trim().toLowerCase();
        if (key && !localTitles.has(key)) externalNames.add(link.trim());
      }
    }
  }

  // Entities. Canon layer, because ingested material is the source material and
  // must stay pristine at play time.
  let written = 0;
  for (const p of prepared) {
    written++;
    report(written, prepared.length, 'writing');
    const props: Record<string, unknown> = { categories: p.categories };
    if (p.infobox) {
      props.infoboxTemplate = p.infobox.template;
      for (const [k, v] of Object.entries(p.infobox.fields)) props[k] = v;
    }

    // Canon-first merge: a secondary source whose title already resolves to
    // a canon entity from a *different* wiki keeps that entity's identity —
    // this page only fills prop keys the primary source never supplied, and
    // a genuinely different summary is kept as a divergence rather than
    // silently replacing what the primary wiki said. A title unique to this
    // wiki, or a page this same wiki already contributed earlier, ingests
    // normally below: "secondary" is a collision policy, not a source-wide
    // demotion.
    const existingCanon = opts.secondary ? existingCanonById.get(p.id) : undefined;
    const foreignPrimary = existingCanon && !existingCanon.provenance.startsWith(`${wiki}:`);

    if (existingCanon && foreignPrimary) {
      const existingCategories = Array.isArray(existingCanon.props.categories) ? (existingCanon.props.categories as string[]) : [];
      const mergedProps: Record<string, unknown> = { ...props, ...existingCanon.props };
      mergedProps.categories = [...new Set([...existingCategories, ...p.categories])];
      const propsChanged = JSON.stringify(mergedProps) !== JSON.stringify(existingCanon.props);
      if (propsChanged) {
        entityWrites.push(
          {
            id: p.id,
            type: existingCanon.type,
            name: existingCanon.name,
            summary: existingCanon.summary,
            provenance: existingCanon.provenance,
            confidence: existingCanon.confidence,
            salience: existingCanon.salience,
            depthLevel: depthFor(p.title),
            props: mergedProps,
            createdScene: existingCanon.createdScene,
          },
        );
      }
      if (p.summary.trim() && p.summary.trim() !== existingCanon.summary.trim()) {
        divergenceWrites.push({ detail: `${wiki} says: ${p.summary.slice(0, 300)}`, canon: existingCanon.provenance });
      }
      result.deferredToCanon.push(p.title);
    } else {
      entityWrites.push(
        {
          id: p.id,
          type: p.type,
          name: p.title,
          summary: p.summary,
          provenance: `${wiki}:${p.title}#${p.page.revision}`,
          confidence: p.infobox ? 0.9 : 0.7,
          salience: 0.3,
          depthLevel: depthFor(p.title),
          props,
          createdScene: 0,
        },
      );
      result.entities++;
    }

    pageWrites.push({ pageId: p.page.pageId, title: p.title, revision: p.page.revision, depth: depthFor(p.title) });
  }

  // Names this batch cannot resolve locally are looked up once, before the edge
   // loops, and cached. `resolveName` is a query now, and the mention pass alone
   // calls this for every wikilink on every page — tens of thousands of times on a
   // real ingest, mostly for the same handful of unresolvable names.
  const resolvedExternally = new Map<string, string | null>();
  for (const name of externalNames) {
    resolvedExternally.set(name.toLowerCase(), (await world.graph.resolveName(name))?.id ?? null);
  }
  const resolve = (name: string): string | null => {
    const key = name.trim().toLowerCase();
    const hit = byTitle.get(key);
    if (hit) return hit.id;
    return resolvedExternally.get(key) ?? null;
  };

  // Typed edges from infobox fields only. Guessing predicates from arbitrary
  // field names yields a graph full of wrong edges, which makes the Referee
  // confidently wrong later - worse than having no edge at all.
  const unmatched = new Map<string, number>();
  for (const p of prepared) {
    if (!p.infobox) continue;
    for (const [field, value] of Object.entries(p.infobox.fields)) {
      const rule = RELATION_FIELDS.find((r) => r.field.test(field));
      if (!rule) {
        // Not an error — most fields are attributes — but a relation-looking
        // name with no rule is exactly how this pass ends up producing almost
        // nothing on a wiki whose vocabulary nobody checked. Counted and
        // reported so the gap is visible instead of silent.
        if (looksRelational(field)) unmatched.set(field, (unmatched.get(field) ?? 0) + 1);
        continue;
      }
      for (const raw of fieldValues(value)) {
        const targetId = resolve(raw);
        if (!targetId || targetId === p.id) continue;
        // `inverse` fields list what the subject *contains*, so the edge runs
        // the other way. See `RELATION_FIELDS`.
        const [subject, object] = rule.inverse ? [targetId, p.id] : [p.id, targetId];
        edgeWrites.push({ subject, predicate: rule.predicate, object, weight: rule.weight, evidence: `infobox ${field}: ${raw}` });
        result.edges++;
      }
    }
  }
  result.unmatchedRelationFields = [...unmatched]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([field, count]) => ({ field, count }));

  // Raw wikilinks as low-weight MENTIONS. Untyped, but useful for relevance and
  // for the graph explorer, and honest about being weak evidence.
  if (opts.recordMentions !== false) {
    for (const p of prepared) {
      for (const link of p.links) {
        const targetId = resolve(link);
        if (!targetId || targetId === p.id) continue;
        edgeWrites.push({ subject: p.id, predicate: 'MENTIONS', object: targetId, weight: 0.15 });
        result.mentions++;
      }
    }
  }

  // Character sheets seeded from infoboxes. A character infobox is effectively a
  // pre-made sheet, which is why Pass A alone produces a playable cast.
  for (const p of prepared) {
    if (p.type !== 'Character') continue;
    const existing = existingSheetById.get(p.id);
    const f = p.infobox?.fields ?? {};

    const identity = { ...(existing?.identity ?? emptyIdentity()) };
    const push = (arr: string[], v?: string) => {
      if (v && !arr.includes(v)) arr.push(v);
    };
    push(identity.allegiances, f.affiliation ?? f.allegiance ?? f.organization);
    push(identity.competencies, f.occupation ?? f.role ?? f.title);
    if (!identity.arc && p.summary) identity.arc = p.summary.slice(0, 200);

    const voice = { ...(existing?.voice ?? emptyVoice()) };
    if (opts.voiceCards) {
      // Quoted dialogue on the page is the cheapest real source of voice.
      for (const q of parseQuotes(p.page.wikitext).slice(0, 6)) {
        if (!voice.samples.includes(q)) voice.samples.push(q);
      }
    }

    const condition = { ...(existing?.condition ?? emptyCondition()) };
    if (!condition.locationId) {
      const home = f.location ?? f.home ?? f.homeworld ?? f.residence;
      if (home) condition.locationId = resolve(home);
    }

    // Species is the cheapest real signal an infobox carries for how a
    // character should be *drawn*, not just who they are. It seeds only the
    // description, never overwrites a hand-written one, and never touches
    // `referenceImagePath` — a re-ingest must not invalidate an existing
    // portrait that play has already conditioned images on.
    const appearance = { ...(existing?.appearance ?? emptyAppearance()) };
    if (!appearance.description && f.species) appearance.description = `${f.species}.`;

    sheetWrites.push({
      entityId: p.id,
      identity,
      contract: existing?.contract ?? emptyContract(),
      voice,
      condition,
      appearance,
      locks: existing?.locks ?? [],
      isPlayer: existing?.isPlayer ?? false,
    });
    result.sheets++;

    // Status from the infobox is what lets the validator catch acting on the dead.
    // Status from the infobox is what lets the validator catch acting on the dead.
    // Applied to the pending write rather than by re-reading and re-writing the
    // row: the entity is still in `entityWrites` and has not been flushed yet.
    const status = (f.status ?? '').toLowerCase();
    if (/dead|deceased|killed/.test(status)) {
      const pending = entityWrites.find((e) => e.id === p.id);
      if (pending) pending.props = { ...(pending.props ?? {}), status: 'dead' };
    }
  }

  // ------------------------------------------------------------------ flush
  //
  // One transaction: a half-ingested world is worse than none, and the batches
  // commit together rather than exposing a visibly half-built canon to a reader.
  // Entities go first so the edges and sheets that reference them land against
  // rows that exist — `checkIntegrity` would otherwise report the intermediate
  // state if it ran mid-ingest.
  await db.tx(async (client) => {
    const w = new World({ db: client, storyId: world.storyId, sources: world.sources });
    await w.graph.upsertMany(entityWrites, 'canon');
    await w.graph.assertEdgesMany(edgeWrites, 0, 'canon', `${wiki}:ingest`);
    await w.cast.putMany(sheetWrites, 'canon');
    for (const d of divergenceWrites) {
      await w.chronicle.addDivergence(0, 'multi-source', d.detail, d.canon);
    }
    if (pageWrites.length) {
      const worldId = world.sources[0]?.worldId;
      if (worldId === undefined) throw new Error('runPassA: the story has no canon world to record pages against');
      for (let i = 0; i < pageWrites.length; i += 500) {
        const chunk = pageWrites.slice(i, i + 500);
        const params: unknown[] = [];
        const tuples = chunk.map((pg) => {
          const base = params.length;
          params.push(worldId, wiki, pg.pageId, pg.title, pg.revision, pg.depth);
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},0,0,now(),'')`;
        });
        await client.query(
          `INSERT INTO ingest_pages (world_id, wiki, page_id, title, revision, depth, hops, score, fetched_at, passb_status)
           VALUES ${tuples.join(',')}
           ON CONFLICT (world_id, wiki, page_id) DO UPDATE SET
             revision = EXCLUDED.revision,
             depth = GREATEST(ingest_pages.depth, EXCLUDED.depth),
             fetched_at = now(),
             passb_status = CASE WHEN ingest_pages.revision <> EXCLUDED.revision THEN '' ELSE ingest_pages.passb_status END`,
          params,
        );
      }
    }
  });

  return result;
}
