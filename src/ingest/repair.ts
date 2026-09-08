/**
 * In-place repair for worlds ingested before events had identity.
 *
 * Why this exists rather than "just re-ingest": Pass B is one model call per
 * page, so re-reading a 3,000-page world costs real money and hours, and the
 * information needed to fix these nodes is already in the database. The damage
 * is structural, not informational.
 *
 * What it fixes, in the order it matters (measured on a real 11,680-entity
 * wiki ingest, which is where every number below comes from):
 *
 * 1. **Identity.** Old event ids were `event:<subjectId>:<counter>` — an event
 *    was a property of the page it was read on. 8,760 synthetic events existed,
 *    26 groups of them sharing byte-identical summaries, because the same
 *    battle described on three pages became three nodes. Re-keying to
 *    `eventIdFor(summary, date)` collapses those groups and makes a future
 *    re-ingest converge on the same ids instead of adding more.
 * 2. **Participants.** 8,140 of those 8,760 sat at degree 1: a single
 *    `INVOLVED_IN` back to the one page that reported them. Merging duplicates
 *    unions their edges, so an event reported by three pages ends up with three
 *    participants — the shared node it should always have been.
 * 3. **Name magnets.** Their `name` was the first 70 characters of the event
 *    sentence, which is why ~15,700 edges (14,205 of them wikilink `MENTIONS`)
 *    had been mis-resolved onto event nodes by the old fuzzy `resolveName`.
 *    Shortening the label removes the bait; `GraphStore.resolveName` refusing
 *    to guess removes the mechanism.
 * 4. **Confetti**, optionally (`prune`). An undated event with one participant
 *    is a sentence about its subject, not an event. Those are moved onto the
 *    subject's own `props.pageEvents` — the same place Pass B now keeps them —
 *    and the node is deleted. Off by default: it deletes rows, and a caller
 *    should say so out loud.
 *
 * Idempotent. Running it twice changes nothing the second time, which is what
 * makes it safe to run against a world of unknown provenance.
 */
import type { World } from '../store/index.ts';
import type { Entity } from '../domain/types.ts';
import { eventIdFor } from './depth.ts';

export interface RepairEventsResult {
  /** Old-scheme event nodes examined. */
  examined: number;
  /** Nodes whose id was re-keyed to a content-derived one. */
  rekeyed: number;
  /** Duplicate nodes folded into a canonical one, their edges unioned. */
  merged: number;
  /** `INVOLVED_IN` edges the merge produced that the separate nodes did not have. */
  participantsGained: number;
  /** Nodes whose prose-length `name` was shortened to a label. */
  relabelled: number;
  /** Undated single-participant nodes moved onto their subject and deleted (only with `prune`). */
  pruned: number;
  /** Edges deleted because they pointed at a pruned node, or duplicated one that already existed. */
  edgesDropped: number;
}

/** Statements kept on an entity. Matches `applyPassB`'s own cap, for the same reason: props are read into prompts. */
const MAX_ENTITY_EVENT_NOTES = 12;

/**
 * True for an id minted by the old counter scheme (`event:<subjectId>:<n>`,
 * which always has a second colon) and false for both a page-derived event
 * (`event:battle-of-the-citadel`) and a content-keyed one (`event:<hex>`).
 *
 * Deliberately a shape test rather than a provenance test: provenance was
 * overwritten by whichever page wrote last, so it cannot be trusted to identify
 * these, whereas the id shape is exactly what the old code produced.
 */
export function isLegacyEventId(id: string): boolean {
  return id.startsWith('event:') && id.slice('event:'.length).includes(':');
}

function shortLabel(text: string): string {
  const clause = text.split(/[,;:.\u2014]/)[0]!.trim();
  const label = clause.length >= 12 && clause.length <= 60 ? clause : text.slice(0, 60).trim();
  return label.length < text.length ? `${label}\u2026` : label;
}

function normalisedText(e: Entity): string {
  return (e.summary || e.name || '').trim();
}

export function repairEvents(world: World, opts: { prune?: boolean } = {}): RepairEventsResult {
  const out: RepairEventsResult = {
    examined: 0,
    rekeyed: 0,
    merged: 0,
    participantsGained: 0,
    relabelled: 0,
    pruned: 0,
    edgesDropped: 0,
  };

  // Read every event node up front. `graph.list` caps at a limit and applies
  // the story overlay; this repair is about canon rows in the file, so it goes
  // to the table directly and in one pass.
  const events = world.db
    .prepare(`SELECT id, name, summary, props, provenance FROM entities WHERE type = 'Event'`)
    .all() as Array<{ id: string; name: string; summary: string; props: string; provenance: string }>;

  const legacy = events.filter((e) => isLegacyEventId(e.id));
  out.examined = legacy.length;
  if (!legacy.length) return out;

  // Group by what the event *is*: content-derived id. Every member of a group
  // is the same event seen from a different page.
  const groups = new Map<string, typeof legacy>();
  for (const e of legacy) {
    const text = normalisedText({ summary: e.summary, name: e.name } as Entity);
    if (!text) continue;
    let date: string | undefined;
    try {
      const props = JSON.parse(e.props || '{}') as { inWorldDate?: unknown };
      if (typeof props.inWorldDate === 'string' && props.inWorldDate.trim()) date = props.inWorldDate;
    } catch {
      // A malformed props blob means "no date", not a failed repair.
    }
    const canonical = eventIdFor(text, date);
    const list = groups.get(canonical) ?? [];
    list.push(e);
    groups.set(canonical, list);
  }

  const repointEdges = (fromId: string, toId: string): void => {
    // Edges are repointed one at a time so an existing identical edge can be
    // detected instead of violating the uniqueness the graph relies on.
    const edges = world.db
      .prepare(`SELECT id, subject, predicate, object FROM edges WHERE subject = ? OR object = ?`)
      .all(fromId, fromId) as Array<{ id: number; subject: string; predicate: string; object: string }>;
    for (const edge of edges) {
      const subject = edge.subject === fromId ? toId : edge.subject;
      const object = edge.object === fromId ? toId : edge.object;
      if (subject === object) {
        // A self-edge, which a merge can produce when two nodes that were both
        // participants of each other collapse. Meaningless, so dropped.
        world.db.prepare(`DELETE FROM edges WHERE id = ?`).run(edge.id);
        out.edgesDropped++;
        continue;
      }
      const existing = world.db
        .prepare(`SELECT id FROM edges WHERE subject = ? AND predicate = ? AND object = ? AND id <> ?`)
        .get(subject, edge.predicate, object, edge.id) as { id: number } | undefined;
      if (existing) {
        world.db.prepare(`DELETE FROM edges WHERE id = ?`).run(edge.id);
        out.edgesDropped++;
        continue;
      }
      world.db.prepare(`UPDATE edges SET subject = ?, object = ? WHERE id = ?`).run(subject, object, edge.id);
    }
  };

  const participantCount = (id: string): number =>
    (
      world.db
        .prepare(`SELECT COUNT(*) AS n FROM edges WHERE object = ? AND predicate = 'INVOLVED_IN'`)
        .get(id) as { n: number }
    ).n;

  for (const [canonicalId, members] of groups) {
    const survivor = members[0]!;
    const before = members.reduce((n, m) => n + participantCount(m.id), 0);

    // Fold the duplicates into the survivor first, then re-key the survivor —
    // in that order, so the intermediate state never has two rows claiming the
    // same id.
    for (const dup of members.slice(1)) {
      repointEdges(dup.id, survivor.id);
      world.db.prepare(`DELETE FROM entities WHERE id = ?`).run(dup.id);
      out.merged++;
    }

    const text = normalisedText({ summary: survivor.summary, name: survivor.name } as Entity);
    const label = shortLabel(text);

    const clash = world.db.prepare(`SELECT id FROM entities WHERE id = ?`).get(canonicalId) as { id: string } | undefined;
    if (clash && canonicalId !== survivor.id) {
      // A content-keyed node for this event already exists (a later ingest
      // wrote it). The legacy row is redundant: give its edges to the existing
      // node and drop it.
      repointEdges(survivor.id, canonicalId);
      world.db.prepare(`DELETE FROM entities WHERE id = ?`).run(survivor.id);
      out.merged++;
    } else if (canonicalId !== survivor.id) {
      world.db.prepare(`UPDATE entities SET id = ?, name = ?, summary = ? WHERE id = ?`).run(canonicalId, label, text, survivor.id);
      repointEdges(survivor.id, canonicalId);
      out.rekeyed++;
      if (survivor.name !== label) out.relabelled++;
    } else if (survivor.name !== label) {
      world.db.prepare(`UPDATE entities SET name = ? WHERE id = ?`).run(label, survivor.id);
      out.relabelled++;
    }

    const after = participantCount(canonicalId);
    if (after > before) out.participantsGained += after - before;
  }

  if (opts.prune) out.pruned += pruneConfetti(world, out);

  return out;
}

/**
 * Deletes undated, single-participant event nodes, keeping their text on the
 * entity that reported them.
 *
 * This is the 8,140-node population: a node per extracted sentence, each
 * hanging off one page by one edge. They are not information — the sentence is
 * preserved on the subject, exactly where `applyPassB` now puts it — they are
 * structure that says nothing, and they dominate every count and every graph
 * render in a world that has them.
 */
function pruneConfetti(world: World, out: RepairEventsResult): number {
  const candidates = world.db
    .prepare(
      `SELECT e.id, e.summary, e.name, e.props FROM entities e
       WHERE e.type = 'Event'
         AND (SELECT COUNT(*) FROM edges g WHERE g.object = e.id AND g.predicate = 'INVOLVED_IN') <= 1`,
    )
    .all() as Array<{ id: string; summary: string; name: string; props: string }>;

  let pruned = 0;
  for (const ev of candidates) {
    let dated = false;
    try {
      const props = JSON.parse(ev.props || '{}') as { inWorldDate?: unknown };
      dated = typeof props.inWorldDate === 'string' && props.inWorldDate.trim().length > 0;
    } catch {
      dated = false;
    }
    // A dated event is a real event even with one known participant: the date
    // is what makes it locatable on a timeline.
    if (dated) continue;

    const text = (ev.summary || ev.name || '').trim();
    const subject = world.db
      .prepare(`SELECT subject FROM edges WHERE object = ? AND predicate = 'INVOLVED_IN' LIMIT 1`)
      .get(ev.id) as { subject: string } | undefined;

    if (subject && text) {
      const owner = world.graph.get(subject.subject);
      if (owner) {
        const existing = Array.isArray(owner.props?.pageEvents) ? (owner.props.pageEvents as unknown[]).map(String) : [];
        const merged = [...new Set([...existing, text])].slice(0, MAX_ENTITY_EVENT_NOTES);
        world.graph.upsert({ ...owner, props: { ...owner.props, pageEvents: merged } }, 'canon');
      }
    }

    const removed = world.db.prepare(`DELETE FROM edges WHERE subject = ? OR object = ?`).run(ev.id, ev.id);
    out.edgesDropped += Number(removed.changes ?? 0);
    world.db.prepare(`DELETE FROM entities WHERE id = ?`).run(ev.id);
    pruned++;
  }
  return pruned;
}
