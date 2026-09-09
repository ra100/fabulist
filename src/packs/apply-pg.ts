/**
 * Applies a world pack: canon once, then one story per scenario.
 *
 * The shape of this file follows the storage layer rather than the pack file.
 * `installPack` writes the shared half — entities, edges, slow sheets — into the
 * canon layer, which carries no `story_id` and is therefore visible to every
 * story in the world file. Then, for each scenario, it creates a `Story` and
 * writes that scenario's chronicle overlay through a `World` bound to it.
 *
 * That is not an arbitrary division. Relationships have no canon layer at all
 * (`store/cast.ts:13`), facts are keyed by `story_id`, threads and directives are
 * story-scoped, and `setSalience` writes chronicle. Anything per-scenario had to
 * live on a story or it would collide between scenarios; anything shared had to
 * live in canon or it would have to be duplicated. The pack format just names
 * the line the database already draws.
 *
 * Validation is warn-and-continue, matching `setup/apply.ts`: a dangling edge is
 * dropped rather than allowed to make the Referee confidently wrong later, but
 * one bad row never fails a whole pack.
 */
import type { EntityId, StoryId } from '../domain/types.ts';
import { defaultKnobs, defaultStyleContract } from '../domain/types.ts';
import type { World } from '../store/index-pg.ts';
import type { Db } from '../db/pg.ts';
import { createStory } from '../store/world-pg.ts';
import { emptyAppearance, emptyCondition, emptyContract, emptyIdentity, emptyVoice } from '../store/cast.ts';
import { isKnownPredicate } from './predicates.ts';
import {
  ENTITY_ID_RE,
  knowledgeLevels,
  SALIENCE,
  TYPE_PREFIX,
  type PackScenario,
  type SalienceTier,
  type WorldPack,
} from './types.ts';

export interface InstalledScenario {
  id: string;
  storyId: StoryId;
  title: string;
  playerCharacterId: string;
  opening: string;
}

export interface InstallResult {
  entities: number;
  edges: number;
  sheets: number;
  scenarios: InstalledScenario[];
  warnings: string[];
}

/**
 * Writes a pack into an empty world file.
 *
 * Returns one entry per scenario, including the `storyId` to bind to. The caller
 * decides which one to open — the pack does not, because "which scenario is
 * current" is a UI choice, not a property of the content.
 */
export async function installPack(db: Db, world: World, pack: WorldPack): Promise<InstallResult> {
  const warnings: string[] = [];
  const result: InstallResult = { entities: 0, edges: 0, sheets: 0, scenarios: [], warnings };

  await world.chronicle.setMeta('worldTitle', pack.title);
  await world.chronicle.setMeta('packId', pack.id);
  await world.chronicle.setMeta('packGenre', pack.genre);
  await world.chronicle.setMeta('packPremise', pack.premise);
  await world.chronicle.setMeta('packLicense', pack.license);

  // ------------------------------------------------------------------ canon

  const ids = new Set<string>();
  for (const e of pack.entities) {
    if (!ENTITY_ID_RE.test(e.id)) {
      warnings.push(`entity id not well formed, skipped: ${e.id}`);
      continue;
    }
    const wantPrefix = TYPE_PREFIX[e.type];
    if (!e.id.startsWith(`${wantPrefix}:`)) {
      // Not fatal — the id is the identity and the type is the truth — but it
      // is almost always a copy-paste error, and a `Character` behind a `loc:`
      // id makes every later id-shaped guess in the pack wrong.
      warnings.push(`${e.id} is a ${e.type}, expected prefix "${wantPrefix}:"`);
    }
    if (ids.has(e.id)) {
      warnings.push(`duplicate entity id, later one ignored: ${e.id}`);
      continue;
    }
    await world.graph.upsert(
      {
        id: e.id,
        type: e.type,
        name: e.name,
        summary: e.summary,
        provenance: `pack:${pack.id}`,
        confidence: 1,
        // Baseline only. Scenarios promote what they need through `focus`,
        // which lands in chronicle and overlays this.
        salience: SALIENCE[e.tier ?? 'supporting'],
        depthLevel: 3,
        props: e.props ?? {},
        createdScene: 0,
      },
      'canon',
    );
    ids.add(e.id);
    result.entities++;
  }

  for (const edge of pack.edges) {
    const predicate = edge.predicate.toUpperCase().replace(/\s+/g, '_');
    if (!ids.has(edge.subject) || !ids.has(edge.object)) {
      warnings.push(`edge references unknown entity, dropped: ${edge.subject} -[${predicate}]-> ${edge.object}`);
      continue;
    }
    if (edge.subject === edge.object) {
      warnings.push(`self-edge dropped: ${edge.subject} -[${predicate}]->`);
      continue;
    }
    // The whole reason `predicates.ts` exists. An unknown predicate is not a
    // weak edge, it is an edge the consequence engine cannot see.
    if (!isKnownPredicate(predicate)) {
      warnings.push(`predicate outside the vocabulary, no consequence will travel it: ${predicate}`);
    }
    await world.graph.assertEdge(
      { subject: edge.subject, predicate, object: edge.object, weight: edge.weight ?? 0.6 },
      0,
      'canon',
      `pack:${pack.id}`,
    );
    result.edges++;
  }

  // Slow half of every sheet, in canon. Condition is deliberately left blank
  // here: where someone stands is a scenario's business, and a canon condition
  // would be inherited by scenarios that wanted them somewhere else.
  for (const s of pack.sheets) {
    if (!ids.has(s.entityId)) {
      warnings.push(`sheet for unknown entity, skipped: ${s.entityId}`);
      continue;
    }
    await world.cast.put(
      {
        entityId: s.entityId,
        identity: { ...emptyIdentity(), ...s.identity },
        contract: { ...emptyContract(), ...s.contract },
        voice: { ...emptyVoice(), ...s.voice },
        condition: emptyCondition(),
        appearance: { ...emptyAppearance(), ...s.appearance },
        locks: [],
        isPlayer: false,
      },
      'canon',
    );
    result.sheets++;
  }

  // -------------------------------------------------------------- scenarios

  if (!pack.scenarios.length) warnings.push('pack has no scenarios; nothing is playable');

  for (const scenario of pack.scenarios) {
    const installed = await installScenario(db, world, pack, scenario, ids, warnings);
    if (installed) result.scenarios.push(installed);
  }

  return result;
}

/**
 * One scenario: a story row plus its chronicle overlay.
 *
 * Uses `world.withStory` rather than opening the file again — a world file can
 * hold many stories over one connection, and every write below is scoped by the
 * `storyId` the returned `World` carries.
 */
async function installScenario(
  db: Db,
  world: World,
  pack: WorldPack,
  scenario: PackScenario,
  ids: Set<string>,
  warnings: string[],
): Promise<InstalledScenario | null> {
  const label = `${pack.id}/${scenario.id}`;

  if (!ids.has(scenario.playerCharacterId)) {
    warnings.push(`${label}: player character ${scenario.playerCharacterId} is not in the pack; scenario skipped`);
    return null;
  }

  // The story reads the same canon worlds the pack was installed into.
  const story = await createStory(db, {
    title: scenario.title,
    worldIds: world.sources.map((src) => src.worldId),
  });
  const w = await world.withStory(story.id);

  // --- salience overlay. The single most consequential block in this file.
  //
  // `frame/builders.ts` shows at most twelve entities to the Narrator, ordered
  // by salience. `focus` is how a scenario says which twelve. Written through
  // `setSalience`, which lands in chronicle and so applies to this story alone —
  // the same canon entity can be focal in one scenario and background in
  // another. It is also what gives salience decay something to act on, since
  // `decaySalience` only touches chronicle rows for the current story.
  const focus = scenario.focus ?? {};
  for (const [entityId, tier] of Object.entries(focus) as Array<[string, SalienceTier]>) {
    if (!ids.has(entityId)) {
      warnings.push(`${label}: focus on unknown entity ${entityId}`);
      continue;
    }
    await w.graph.setSalience(entityId, SALIENCE[tier]);
  }
  // The player and the opening location are always focal, stated or not:
  // forgetting them would evict the protagonist from their own scene.
  await w.graph.setSalience(scenario.playerCharacterId, SALIENCE.focal);
  if (ids.has(scenario.openingLocationId)) w.graph.setSalience(scenario.openingLocationId, SALIENCE.focal);
  else warnings.push(`${label}: opening location ${scenario.openingLocationId} is not in the pack`);

  // --- conditions. The fast half of the sheet, and the thing that decides who
  // is on stage: `presentIds` matches `condition.locationId` against the
  // session's location by *exact* equality and does not walk PART_OF, so an NPC
  // one room away is offstage. Co-locating the cast is how an ensemble happens.
  for (const c of scenario.conditions ?? []) {
    const { entityId, ...patch } = c;
    if (!ids.has(entityId)) {
      warnings.push(`${label}: condition for unknown entity ${entityId}`);
      continue;
    }
    if (patch.locationId && !ids.has(patch.locationId)) {
      warnings.push(`${label}: ${entityId} placed at unknown location ${patch.locationId}`);
      delete patch.locationId;
    }
    const existing = await w.cast.get(entityId);
    await w.cast.put({
      entityId,
      identity: existing?.identity ?? emptyIdentity(),
      contract: existing?.contract ?? emptyContract(),
      voice: existing?.voice ?? emptyVoice(),
      appearance: existing?.appearance ?? emptyAppearance(),
      condition: { ...emptyCondition(), ...patch },
      locks: existing?.locks ?? [],
      isPlayer: entityId === scenario.playerCharacterId,
    });
  }

  // The player needs a chronicle sheet flagged `isPlayer` even with no authored
  // condition, or `cast.player()` finds nobody and the integrity gate has no
  // contract to read.
  if (!(scenario.conditions ?? []).some((c) => c.entityId === scenario.playerCharacterId)) {
    const existing = await w.cast.get(scenario.playerCharacterId);
    await w.cast.put({
      entityId: scenario.playerCharacterId,
      identity: existing?.identity ?? emptyIdentity(),
      contract: existing?.contract ?? emptyContract(),
      voice: existing?.voice ?? emptyVoice(),
      appearance: existing?.appearance ?? emptyAppearance(),
      condition: { ...emptyCondition(), locationId: scenario.openingLocationId },
      locks: existing?.locks ?? [],
      isPlayer: true,
    });
  }

  const playerSheet = await w.cast.get(scenario.playerCharacterId);
  if (!playerSheet?.contract.vows.length) {
    warnings.push(
      `${label}: player ${scenario.playerCharacterId} has no vows, so the integrity gate has nothing to defend`,
    );
  }

  // --- relationships. Directional and asymmetric on purpose; a pack that
  // authors only one direction gets a world where nobody's regard is
  // unrequited, which is most of what drama is made of.
  for (const r of scenario.relationships ?? []) {
    if (!ids.has(r.from) || !ids.has(r.to)) {
      warnings.push(`${label}: relationship between unknown entities ${r.from} -> ${r.to}`);
      continue;
    }
    await w.cast.adjustRelationship(r.from, r.to, {
      trust: r.trust ?? 0,
      affection: r.affection ?? 0,
      respect: r.respect ?? 0,
      note: r.note ?? '',
    });
  }

  // --- facts and who believes them. The asymmetry is the story engine: the
  // player knowing something the antagonist does not, and vice versa.
  for (const f of scenario.facts ?? []) {
    const fact = await w.chronicle.addFact(f.text, 0);
    for (const [entityId, level] of knowledgeLevels(f)) {
      if (!ids.has(entityId)) {
        warnings.push(`${label}: unknown entity ${entityId} in knowledge of "${f.text.slice(0, 40)}…"`);
        continue;
      }
      await w.chronicle.setKnowledge(fact.id, entityId, level, 0);
    }
  }

  // --- threads. Several resolutions each, never one.
  for (const t of scenario.threads ?? []) {
    const parties = t.parties.filter((p) => {
      if (ids.has(p)) return true;
      warnings.push(`${label}: unknown party ${p} on thread "${t.title}"`);
      return false;
    });
    if (t.resolutions.length < 2) {
      warnings.push(`${label}: thread "${t.title}" has fewer than two resolutions, which makes it a plot`);
    }
    await w.threads.create({
      title: t.title,
      stakes: t.stakes,
      tension: t.tension,
      parties,
      resolutions: t.resolutions,
      status: t.status ?? 'open',
      createdScene: 1,
    });
  }

  if (scenario.anchor) w.chronicle.addAnchor(scenario.anchor.text, scenario.anchor.note ?? `${pack.id} anchor`, 0);

  await w.chronicle.upsertScene(1, {
    title: scenario.openingScene,
    summary: '',
    locationId: ids.has(scenario.openingLocationId) ? scenario.openingLocationId : null,
    chapter: 1,
  });

  await w.session.set({
    scene: 1,
    turn: 0,
    playerCharacterId: scenario.playerCharacterId,
    currentLocationId: ids.has(scenario.openingLocationId) ? scenario.openingLocationId : null,
    style: { ...defaultStyleContract(), ...scenario.style },
    knobs: defaultKnobs(),
  });

  return {
    id: scenario.id,
    storyId: story.id,
    title: scenario.title,
    playerCharacterId: scenario.playerCharacterId,
    opening: scenario.opening ?? '',
  };
}

/**
 * Static checks that need no database, so a test can assert every shipped pack
 * without installing it. Deliberately stricter than `installPack`: the applier
 * has to survive imperfect input, but a pack *we* ship should have none of
 * these problems.
 */
export function lintPack(pack: WorldPack): string[] {
  const problems: string[] = [];
  const ids = new Map<string, string>();

  for (const e of pack.entities) {
    if (!ENTITY_ID_RE.test(e.id)) problems.push(`malformed id: ${e.id}`);
    if (ids.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    ids.set(e.id, e.type);
    if (!e.id.startsWith(`${TYPE_PREFIX[e.type]}:`)) problems.push(`${e.id} typed ${e.type}, prefix mismatch`);
    if (!e.summary.trim()) problems.push(`${e.id} has no summary, so its thumbnail is a bare name`);
  }

  for (const edge of pack.edges) {
    const predicate = edge.predicate.toUpperCase();
    if (!ids.has(edge.subject)) problems.push(`edge from unknown ${edge.subject}`);
    if (!ids.has(edge.object)) problems.push(`edge to unknown ${edge.object}`);
    if (!isKnownPredicate(predicate)) problems.push(`unknown predicate ${predicate}`);
  }

  for (const s of pack.sheets) {
    if (!ids.has(s.entityId)) problems.push(`sheet for unknown ${s.entityId}`);
    else if (ids.get(s.entityId) !== 'Character') problems.push(`sheet on non-character ${s.entityId}`);
  }

  if (!pack.scenarios.length) problems.push('no scenarios');

  // Pack-level `focal` is a mistake the `BaselineTier` type already prevents for
  // packs written in TypeScript. This check exists for the case types cannot
  // reach: a pack parsed from JSON at runtime. The reasoning is on `BaselineTier`.
  const packFocal = pack.entities.filter((e) => (e.tier as string) === 'focal');
  if (packFocal.length) {
    problems.push(
      `${packFocal.length} entities are focal at pack level; focal belongs on a scenario's focus map, ` +
        `or they tie at the top of every story's salience and the frame picks between them alphabetically`,
    );
  }

  const seenScenario = new Set<string>();
  for (const sc of pack.scenarios) {
    const label = `scenario ${sc.id}`;
    if (seenScenario.has(sc.id)) problems.push(`duplicate ${label}`);
    seenScenario.add(sc.id);

    if (ids.get(sc.playerCharacterId) !== 'Character') {
      problems.push(`${label}: player ${sc.playerCharacterId} is not a Character in this pack`);
    }
    if (ids.get(sc.openingLocationId) !== 'Location') {
      problems.push(`${label}: opening location ${sc.openingLocationId} is not a Location in this pack`);
    }

    const sheet = pack.sheets.find((s) => s.entityId === sc.playerCharacterId);
    if (!sheet?.contract?.vows?.length) problems.push(`${label}: player has no vows`);

    // The engine-shaped minimum for a scenario to actually generate pressure.
    if ((sc.threads ?? []).length < 2) problems.push(`${label}: fewer than two threads`);
    for (const t of sc.threads ?? []) {
      if (t.resolutions.length < 2) problems.push(`${label}: thread "${t.title}" has one resolution`);
    }
    if (!(sc.facts ?? []).some((f) => (f.knows?.length ?? 0) + (f.suspects?.length ?? 0) >= 2)) {
      problems.push(`${label}: no fact is known or suspected by two or more parties, so there is no asymmetry`);
    }

    // Twelve is the Narrator's hard window; a scenario that promotes more than
    // that has not actually chosen.
    const focal = Object.values(sc.focus ?? {}).filter((t) => t === 'focal').length;
    if (focal > 12) problems.push(`${label}: ${focal} focal entities, more than the frame can show`);

    for (const id of Object.keys(sc.focus ?? {})) {
      if (!ids.has(id)) problems.push(`${label}: focus on unknown ${id}`);
    }
    for (const c of sc.conditions ?? []) {
      if (!ids.has(c.entityId)) problems.push(`${label}: condition for unknown ${c.entityId}`);
      if (c.locationId && !ids.has(c.locationId)) problems.push(`${label}: unknown location ${c.locationId}`);
    }
    for (const r of sc.relationships ?? []) {
      if (!ids.has(r.from) || !ids.has(r.to)) problems.push(`${label}: relationship ${r.from} -> ${r.to} dangles`);
    }
  }

  return problems;
}

/** Entity ids a pack references but never defines. Cheap to check, expensive to miss. */
export function danglingIds(pack: WorldPack): EntityId[] {
  const defined = new Set(pack.entities.map((e) => e.id));
  const referenced = new Set<string>();
  for (const e of pack.edges) {
    referenced.add(e.subject);
    referenced.add(e.object);
  }
  for (const s of pack.sheets) referenced.add(s.entityId);
  for (const sc of pack.scenarios) {
    referenced.add(sc.playerCharacterId);
    referenced.add(sc.openingLocationId);
    for (const id of Object.keys(sc.focus ?? {})) referenced.add(id);
    for (const c of sc.conditions ?? []) {
      referenced.add(c.entityId);
      if (c.locationId) referenced.add(c.locationId);
    }
    for (const r of sc.relationships ?? []) {
      referenced.add(r.from);
      referenced.add(r.to);
    }
    for (const f of sc.facts ?? []) for (const [id] of knowledgeLevels(f)) referenced.add(id);
    for (const t of sc.threads ?? []) for (const p of t.parties) referenced.add(p);
  }
  return [...referenced].filter((id) => !defined.has(id)).sort();
}
