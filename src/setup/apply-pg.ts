/**
 * Applies a setup plan to a world.
 *
 * Two paths land here: a wiki ingest, and a custom world built from a
 * description. They converge deliberately — after either one the engine sees the
 * same thing, so nothing downstream needs to know where the canon came from.
 */
import type { Entity, EntityType, StyleContract, Vow } from '../domain/types.ts';
import type { World } from '../store/index-pg.ts';
import { emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../store/cast.ts';
import { slugify } from '../ingest/parse.ts';
import type { CharacterSketch } from './planner.ts';

export interface ApplyCustomResult {
  entities: number;
  edges: number;
  sheets: number;
  threads: number;
  facts: number;
  playerCharacterId: string;
  opening: string;
  warnings: string[];
}

const TYPES: EntityType[] = ['Character', 'Location', 'Faction', 'Item', 'Concept', 'Event'];

/**
 * Writes a generated world into canon.
 *
 * Generated material goes to the canon layer, not chronicle: for an authored
 * world this *is* the source material, so the same copy-on-write behaviour that
 * protects a wiki ingest should protect it too — including the ability to branch
 * a fresh playthrough from it later.
 */
export async function applyCustomWorld(world: World, raw: Record<string, unknown>): Promise<ApplyCustomResult> {
  const warnings: string[] = [];
  const result: ApplyCustomResult = {
    entities: 0, edges: 0, sheets: 0, threads: 0, facts: 0,
    playerCharacterId: '', opening: String(raw.opening ?? ''), warnings,
  };

  const entities = asArray(raw.entities).map((e) => e as Record<string, unknown>);
  const ids = new Set<string>();

  for (const e of entities) {
    const id = String(e.id ?? '').trim();
    const name = String(e.name ?? '').trim();
    const type = TYPES.includes(e.type as EntityType) ? (e.type as EntityType) : 'Concept';
    if (!id || !name || !/^[a-z]+:[a-z0-9-]+$/.test(id)) {
      warnings.push(`skipped entity with bad id: ${id || name || '(unnamed)'}`);
      continue;
    }
    await world.graph.upsert(
      {
        id,
        type,
        name,
        summary: String(e.summary ?? ''),
        provenance: 'authored',
        confidence: 1,
        salience: 0.4,
        depthLevel: 3,
        props: {},
        createdScene: 0,
      },
      'canon',
    );
    ids.add(id);
    result.entities++;
  }

  for (const raw_edge of asArray(raw.edges)) {
    const e = raw_edge as Record<string, unknown>;
    const subject = String(e.subject ?? '');
    const object = String(e.object ?? '');
    const predicate = String(e.predicate ?? '').toUpperCase().replace(/\s+/g, '_');
    // Dangling edges make the Referee confidently wrong later, so drop rather
    // than invent the missing node.
    if (!ids.has(subject) || !ids.has(object) || !predicate || subject === object) {
      warnings.push(`skipped edge ${subject} -[${predicate}]-> ${object}`);
      continue;
    }
    await world.graph.assertEdge({ subject, predicate, object, weight: num(e.weight, 0.6) }, 0, 'canon', 'authored');
    result.edges++;
  }

  const playerId = String(raw.playerCharacterId ?? '');
  const characters = [...ids].filter((id) => id.startsWith('char:'));
  result.playerCharacterId = ids.has(playerId) ? playerId : (characters[0] ?? '');
  if (!ids.has(playerId) && result.playerCharacterId) {
    warnings.push(`player character ${playerId} not found; using ${result.playerCharacterId}`);
  }

  for (const raw_sheet of asArray(raw.sheets)) {
    const s = raw_sheet as Record<string, unknown>;
    const entityId = String(s.entityId ?? '');
    if (!ids.has(entityId)) continue;

    const locationId = typeof s.locationId === 'string' && ids.has(s.locationId) ? s.locationId : null;
    await world.cast.put({
      entityId,
      identity: {
        ...emptyIdentity(),
        goals: asArray(s.goals).map(String).slice(0, 6),
        fears: asArray(s.fears).map(String).slice(0, 5),
        secrets: asArray(s.secrets).map(String).slice(0, 5),
      },
      contract: { ...emptyContract(), vows: toVows(asArray(s.vows)) },
      voice: { ...emptyVoice(), diction: String(s.diction ?? '') },
      condition: { ...emptyCondition(), locationId },
      appearance: emptyAppearance(),
      locks: [],
      isPlayer: entityId === result.playerCharacterId,
    }, 'canon');
    result.sheets++;
  }

  // The player must have a sheet with vows, or the integrity gate has nothing to
  // defend and the most distinctive feature of the engine silently does nothing.
  if (result.playerCharacterId && !(await world.cast.get(result.playerCharacterId))) {
    await world.cast.put({
      entityId: result.playerCharacterId,
      identity: emptyIdentity(),
      contract: emptyContract(),
      voice: emptyVoice(),
      condition: emptyCondition(),
      appearance: emptyAppearance(),
      locks: [],
      isPlayer: true,
    }, 'canon');
    result.sheets++;
    warnings.push('player character had no sheet; created a blank one');
  }

  // Flag the protagonist in *chronicle*, not canon.
  //
  // `is_player` exists only on `chron_sheets` by design — who the protagonist is
  // is a property of a playthrough, not of the source material, and two stories in
  // one world have different players. A canon sheet carrying `isPlayer: true`
  // therefore drops the flag silently, and `cast.player()` finds nobody. Caught by
  // a test asserting a described world is playable; the same shape bit the SQLite
  // importer, where real saves flagged the player on a canon row.
  if (result.playerCharacterId) {
    const baseline = await world.cast.get(result.playerCharacterId);
    if (baseline) await world.cast.put({ ...baseline, isPlayer: true }, 'chronicle');
  }

  for (const raw_rel of asArray(raw.relationships)) {
    const r = raw_rel as Record<string, unknown>;
    const fromId = String(r.fromId ?? '');
    const toId = String(r.toId ?? '');
    if (!ids.has(fromId) || !ids.has(toId) || fromId === toId) continue;
    await world.cast.adjustRelationship(fromId, toId, {
      trust: num(r.trust, 0),
      affection: num(r.affection, 0),
      respect: num(r.respect, 0),
      note: String(r.note ?? ''),
    });
  }

  for (const raw_thread of asArray(raw.threads)) {
    const t = raw_thread as Record<string, unknown>;
    const title = String(t.title ?? '').trim();
    if (!title) continue;
    const resolutions = asArray(t.resolutions).map(String).filter(Boolean);
    await world.threads.create({
      title,
      stakes: String(t.stakes ?? ''),
      tension: Math.max(0, Math.min(1, num(t.tension, 0.5))),
      parties: asArray(t.parties).map(String).filter((p) => ids.has(p)),
      // Never one resolution: a single path is a plot, and a plot breaks on deviation.
      resolutions: resolutions.length > 1 ? resolutions : [...resolutions, 'it escalates', 'it fades'],
      status: 'open',
      createdScene: 1,
    });
    result.threads++;
  }

  for (const raw_fact of asArray(raw.facts)) {
    const f = raw_fact as Record<string, unknown>;
    const text = String(f.text ?? '').trim();
    if (!text) continue;
    const fact = await world.chronicle.addFact(text, 0);
    for (const id of asArray(f.knownBy).map(String).filter((x) => ids.has(x))) {
      await world.chronicle.setKnowledge(fact.id, id, 'knows', 0);
    }
    for (const id of asArray(f.suspectedBy).map(String).filter((x) => ids.has(x))) {
      await world.chronicle.setKnowledge(fact.id, id, 'suspects', 0);
    }
    result.facts++;
  }

  const startLocation =
    (await world.cast.get(result.playerCharacterId))?.condition.locationId ??
    [...ids].find((id) => id.startsWith('loc:')) ??
    null;

  await world.session.set({ scene: 1, turn: 0, playerCharacterId: result.playerCharacterId, currentLocationId: startLocation });
  await world.chronicle.upsertScene(1, { title: String(raw.title ?? ''), summary: '', locationId: startLocation, chapter: 1 });
  // Awaited, unlike the SQLite original this was converted from, where `setMeta`
  // was synchronous. Unawaited it could only ever fail as an unhandled
  // rejection — the job reported success and the process took the throw.
  if (raw.title) await world.chronicle.setMeta('worldTitle', String(raw.title));

  return result;
}

/**
 * Attaches the player to an ingested world: either an existing character from the
 * wiki, or an original one placed inside it.
 */
export async function assignPlayerCharacter(
  world: World,
  sketch: CharacterSketch,
): Promise<{ playerCharacterId: string; created: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  // Clear any previous player flag, or two characters end up marked.
  for (const sheet of await world.cast.list()) {
    if (sheet.isPlayer) world.cast.put({ ...sheet, isPlayer: false });
  }

  let entity: Entity | undefined;
  let created = false;

  if (sketch.existing) {
    entity = await world.graph.resolveName(sketch.existing);
    if (!entity) warnings.push(`"${sketch.existing}" is not in this world; creating an original character instead`);
  }

  if (!entity) {
    const name = sketch.name || 'The Newcomer';
    const id = `char:${slugify(name)}`;
    await world.graph.upsert(
      {
        id,
        type: 'Character',
        name,
        summary: sketch.role || 'An original character.',
        // Marked emergent, not canon: an invented protagonist is not source material.
        provenance: 'emergent:0',
        confidence: 1,
        salience: 0.9,
        depthLevel: 3,
        props: {},
        createdScene: 0,
      },
      'chronicle',
    );
    entity = await world.graph.get(id);
    created = true;
  }

  if (!entity) return { playerCharacterId: '', created: false, warnings: ['could not create a player character'] };

  const existing = await world.cast.get(entity.id);
  const start =
    existing?.condition.locationId ??
    (await world.graph.list({ type: 'Location', limit: 1 }))[0]?.id ??
    null;

  await world.cast.put({
    entityId: entity.id,
    identity: {
      ...(existing?.identity ?? emptyIdentity()),
      goals: sketch.goals.length ? sketch.goals : (existing?.identity.goals ?? []),
    },
    contract: {
      ...(existing?.contract ?? emptyContract()),
      vows: sketch.vows.length ? toVows(sketch.vows) : (existing?.contract.vows ?? []),
    },
    voice: existing?.voice ?? emptyVoice(),
    condition: { ...(existing?.condition ?? emptyCondition()), locationId: start },
    appearance: existing?.appearance ?? emptyAppearance(),
    locks: existing?.locks ?? [],
    isPlayer: true,
  });

  await world.graph.bumpSalience([entity.id], 0.6);
  await world.session.set({ playerCharacterId: entity.id, currentLocationId: start });

  if (!sketch.vows.length && !(existing?.contract.vows.length)) {
    warnings.push('this character has no vows, so the integrity gate has nothing to defend');
  }

  return { playerCharacterId: entity.id, created, warnings };
}

export async function applyStyle(world: World, style: Partial<StyleContract>): Promise<StyleContract> {
  const current = await world.session.get();
  const next = { ...current.style, ...style };
  await world.session.set({ style: next });
  return next;
}

/**
 * Proposes where to begin, from the highest-tension thread rather than at random.
 * Starting in a scene that already has pressure is worth more than any amount of
 * scene-setting.
 *
 * A fresh wiki ingest usually has no threads yet — canon describes a world, not a
 * situation — so the fallback is built from the graph instead of boilerplate. A
 * named place and a named person the player is connected to gives the Director
 * something to push against; "you are somewhere, something will happen" gives it
 * nothing.
 */
export async function proposeOpening(world: World, fallback = ''): Promise<string> {
  const session = await world.session.get();
  const player = session.playerCharacterId;
  const thread = (await world.threads.open(1))[0];

  if (thread) {
    // Party names and the location in one batch rather than one query each.
    const partyIds = thread.parties.filter((p) => p !== player);
    const named = await world.graph.getMany([...partyIds, session.currentLocationId ?? '']);
    const others = partyIds.map((p) => named.get(p)?.name).filter(Boolean);
    const where = named.get(session.currentLocationId ?? '')?.name;
    // Thread titles are written as fragments, so they need a stop before the
    // next sentence or the opening reads as one run-on line.
    const stop = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
    return [
      stop(thread.title),
      thread.stakes ? `At stake: ${thread.stakes}.` : '',
      others.length ? `Present: ${others.join(', ')}.` : '',
      where ? `You are at ${where}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (fallback) return fallback;

  // Three independent reads, overlapped: they go through the pool, so this is one
  // round trip's latency rather than three.
  const [where, characters, factions] = await Promise.all([
    world.graph.get(session.currentLocationId ?? ''),
    world.graph.list({ type: 'Character', limit: 40 }),
    world.graph.list({ type: 'Faction', limit: 1 }),
  ]);

  // The best-connected character who is not the player: the person most likely to
  // matter in this corner of the world. Degrees come from one batched
  // neighbourhood read rather than a query per candidate — this ran 40 times.
  const candidates = characters.filter((e) => e.id !== player);
  const degrees = await world.graph.neighboursMany(candidates.map((e) => e.id));
  const nearby = candidates
    .map((e) => ({ entity: e, links: (degrees.get(e.id) ?? []).length }))
    .sort((a, b) => b.links - a.links)[0];

  const faction = factions[0];
  const parts: string[] = [];

  if (where) parts.push(`You are at ${where.name}${where.summary ? `. ${where.summary}` : '.'}`);
  if (nearby) {
    parts.push(
      `${nearby.entity.name} is here and wants something from you${nearby.entity.summary ? ` — ${lowerFirst(nearby.entity.summary)}` : '.'}`,
    );
  }
  if (faction && !nearby) parts.push(`${faction.name} has taken an interest in you.`);
  if (!parts.length) parts.push('Something is about to require a decision.');

  return parts.join(' ');
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function toVows(raw: unknown[]): Vow[] {
  return raw
    .map((v) => v as Record<string, unknown>)
    .filter((v) => typeof v.text === 'string' && v.text.trim().length > 3)
    .map((v, i) => ({
      id: slugify(String(v.text)).split('-').slice(0, 3).join('-') || `vow-${i + 1}`,
      text: String(v.text).trim(),
      rank: typeof v.rank === 'number' ? v.rank : i + 1,
      broken: false,
      brokenScene: null,
    }))
    .slice(0, 5);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
