/**
 * Pass A: structural extraction, no LLM. See DESIGN.md §3.
 *
 * Idempotency strategy: entity ids are deterministic slugs of (type, title), and
 * both `graph.upsert` and `graph.assertEdge` are upserts keyed on those ids. So
 * running Pass A twice updates in place rather than duplicating, which is what
 * makes re-ingest a diff and depth upgrades resumable.
 */
import type { DepthLevelValue, EntityType } from '../domain/types.ts';
import type { World } from '../store/index.ts';
import { emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../store/cast.ts';
import type { WikiPage } from './client.ts';
import {
  fieldValues,
  firstParagraph,
  inferEntityType,
  parseCategories,
  parseInfobox,
  parseLinks,
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
}

export interface PassAOptions {
  depth?: DepthLevelValue;
  wiki?: string;
  /** Record raw wikilinks as low-weight MENTIONS edges. */
  recordMentions?: boolean;
  /** Mine quoted dialogue into voice cards (mid depth and above). */
  voiceCards?: boolean;
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

export function runPassA(world: World, pages: WikiPage[], opts: PassAOptions = {}): PassAResult {
  const depth = opts.depth ?? 1;
  const wiki = opts.wiki ?? 'wiki';
  const result: PassAResult = { entities: 0, edges: 0, sheets: 0, mentions: 0, skipped: [], deferredToCanon: [] };

  // First pass: decide every id before writing edges, so a relation to a page in
  // this batch resolves rather than dangling.
  const prepared: Prepared[] = [];
  const byTitle = new Map<string, Prepared>();

  for (const page of pages) {
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

  // Entities. Canon layer, because ingested material is the source material and
  // must stay pristine at play time.
  for (const p of prepared) {
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
    const existingCanon = opts.secondary ? world.graph.getCanon(p.id) : undefined;
    const foreignPrimary = existingCanon && !existingCanon.provenance.startsWith(`${wiki}:`);

    if (existingCanon && foreignPrimary) {
      const existingCategories = Array.isArray(existingCanon.props.categories) ? (existingCanon.props.categories as string[]) : [];
      const mergedProps: Record<string, unknown> = { ...props, ...existingCanon.props };
      mergedProps.categories = [...new Set([...existingCategories, ...p.categories])];
      const propsChanged = JSON.stringify(mergedProps) !== JSON.stringify(existingCanon.props);
      if (propsChanged) {
        world.graph.upsert(
          {
            id: p.id,
            type: existingCanon.type,
            name: existingCanon.name,
            summary: existingCanon.summary,
            provenance: existingCanon.provenance,
            confidence: existingCanon.confidence,
            salience: existingCanon.salience,
            depthLevel: depth,
            props: mergedProps,
            createdScene: existingCanon.createdScene,
          },
          'canon',
        );
      }
      if (p.summary.trim() && p.summary.trim() !== existingCanon.summary.trim()) {
        world.chronicle.addDivergence(0, 'multi-source', `${wiki} says: ${p.summary.slice(0, 300)}`, existingCanon.provenance);
      }
      result.deferredToCanon.push(p.title);
    } else {
      world.graph.upsert(
        {
          id: p.id,
          type: p.type,
          name: p.title,
          summary: p.summary,
          provenance: `${wiki}:${p.title}#${p.page.revision}`,
          confidence: p.infobox ? 0.9 : 0.7,
          salience: 0.3,
          depthLevel: depth,
          props,
          createdScene: 0,
        },
        'canon',
      );
      result.entities++;
    }

    world.db
      .prepare(
        `INSERT INTO ingest_pages (page_id, wiki, title, revision, depth, hops, score, fetched_at)
         VALUES (?,?,?,?,?,0,0,?)
         ON CONFLICT(wiki, page_id) DO UPDATE SET
           revision = excluded.revision, depth = MAX(ingest_pages.depth, excluded.depth),
           fetched_at = excluded.fetched_at`,
      )
      .run(p.page.pageId, wiki, p.title, p.page.revision, depth, new Date().toISOString());
  }

  const resolve = (name: string): string | null => {
    const hit = byTitle.get(name.trim().toLowerCase());
    if (hit) return hit.id;
    // Already in the graph from an earlier ingest run.
    const existing = world.graph.resolveName(name.trim());
    return existing?.id ?? null;
  };

  // Typed edges from infobox fields only. Guessing predicates from arbitrary
  // field names yields a graph full of wrong edges, which makes the Referee
  // confidently wrong later - worse than having no edge at all.
  for (const p of prepared) {
    if (!p.infobox) continue;
    for (const [field, value] of Object.entries(p.infobox.fields)) {
      const rule = RELATION_FIELDS.find((r) => r.field.test(field));
      if (!rule) continue;
      for (const raw of fieldValues(value)) {
        const targetId = resolve(raw);
        if (!targetId || targetId === p.id) continue;
        world.graph.assertEdge(
          { subject: p.id, predicate: rule.predicate, object: targetId, weight: rule.weight, evidence: `infobox ${field}: ${raw}` },
          0,
          'canon',
          `${wiki}:${p.title}`,
        );
        result.edges++;
      }
    }
  }

  // Raw wikilinks as low-weight MENTIONS. Untyped, but useful for relevance and
  // for the graph explorer, and honest about being weak evidence.
  if (opts.recordMentions !== false) {
    for (const p of prepared) {
      for (const link of p.links) {
        const targetId = resolve(link);
        if (!targetId || targetId === p.id) continue;
        world.graph.assertEdge({ subject: p.id, predicate: 'MENTIONS', object: targetId, weight: 0.15 }, 0, 'canon', `${wiki}:${p.title}`);
        result.mentions++;
      }
    }
  }

  // Character sheets seeded from infoboxes. A character infobox is effectively a
  // pre-made sheet, which is why Pass A alone produces a playable cast.
  for (const p of prepared) {
    if (p.type !== 'Character') continue;
    const existing = world.cast.get(p.id);
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

    world.cast.put({
      entityId: p.id,
      identity,
      contract: existing?.contract ?? emptyContract(),
      voice,
      condition,
      appearance,
      locks: existing?.locks ?? [],
      isPlayer: existing?.isPlayer ?? false,
    }, 'canon');
    result.sheets++;

    // Status from the infobox is what lets the validator catch acting on the dead.
    const status = (f.status ?? '').toLowerCase();
    if (/dead|deceased|killed/.test(status)) {
      const entity = world.graph.get(p.id);
      if (entity) {
        world.graph.upsert({ ...entity, props: { ...entity.props, status: 'dead' } }, 'canon');
      }
    }
  }

  return result;
}
