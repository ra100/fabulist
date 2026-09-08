#!/usr/bin/env node
/**
 * Repairs the event graph of a world ingested before events had identity.
 *
 *   pnpm repair-events --world=mass-effect-wiki            # report only
 *   pnpm repair-events --world=mass-effect-wiki --write
 *   pnpm repair-events --world=mass-effect-wiki --write --prune
 *
 * Reports by default and writes nothing: this rewrites ids and merges nodes, so
 * the shape of the change should be visible before it happens. `--prune`
 * additionally deletes undated single-participant event nodes after moving their
 * text onto the entity that reported them — see `repairEvents` for why those
 * nodes are structure without information.
 */
import { World } from '../store/index.ts';
import { resolveCurrentStory } from '../store/world.ts';
import { listWorlds, pathsFor } from '../store/worlds.ts';
import { repairEvents, isLegacyEventId } from '../ingest/repair.ts';
import { openDb, tx } from '../db/db.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const slug = flag('world');
const write = args.includes('--write');
const prune = args.includes('--prune');
const dataRoot = flag('data') ?? 'data';

if (!slug) {
  const worlds = listWorlds(dataRoot);
  console.log(`usage: pnpm repair-events --world=<slug> [--write] [--prune] [--data=data]

  --world=<slug>   which world to repair
  --write          apply the repair (otherwise report only)
  --prune          also delete undated single-participant event nodes, keeping
                   their text on the entity that reported them
  --data=<dir>     data root, default "data"

worlds here:${worlds.length ? '' : ' (none)'}`);
  for (const w of worlds) console.log(`  ${w.slug.padEnd(28)} ${w.entityCount.toLocaleString()} entities`);
  process.exit(0);
}

const paths = pathsFor(slug, dataRoot);
const db = openDb(paths.dbPath);
// Event repair reads and writes shared canon rows, not story-scoped state. Bind
// a World to the current story only because its stores require that handle.
const world = new World(db, resolveCurrentStory(db), paths.imagesDir);

const before = snapshot();
console.log(`world "${slug}": ${before.entities.toLocaleString()} entities, ${before.edges.toLocaleString()} edges`);
console.log(
  `events: ${before.events.toLocaleString()} total, ${before.legacy.toLocaleString()} on the old id scheme, ` +
    `${before.degreeOne.toLocaleString()} with a single participant`,
);

if (!write) {
  console.log('\nnothing written. re-run with --write to apply (add --prune to drop single-participant undated events).');
  world.close();
  process.exit(0);
}

// One transaction: a half-merged event graph is worse than an unrepaired one.
const result = tx(world.db, () => repairEvents(world, { prune }));

const after = snapshot();
console.log(`
examined ${result.examined.toLocaleString()} legacy event node(s)
  re-keyed to content ids   ${result.rekeyed.toLocaleString()}
  duplicates merged         ${result.merged.toLocaleString()}
  participant links gained  ${result.participantsGained.toLocaleString()}
  labels shortened          ${result.relabelled.toLocaleString()}
  pruned to entity props    ${result.pruned.toLocaleString()}
  edges dropped             ${result.edgesDropped.toLocaleString()}

now: ${after.entities.toLocaleString()} entities, ${after.edges.toLocaleString()} edges, ${after.events.toLocaleString()} events (${after.degreeOne.toLocaleString()} with a single participant)`);
world.close();

function snapshot() {
  const n = (sql: string): number => (world.db.prepare(sql).get() as { n: number }).n;
  const ids = world.db.prepare(`SELECT id FROM entities WHERE type = 'Event'`).all() as Array<{ id: string }>;
  return {
    entities: n(`SELECT COUNT(*) AS n FROM entities`),
    edges: n(`SELECT COUNT(*) AS n FROM edges`),
    events: ids.length,
    legacy: ids.filter((r) => isLegacyEventId(r.id)).length,
    degreeOne: n(
      `SELECT COUNT(*) AS n FROM entities e WHERE e.type = 'Event'
         AND (SELECT COUNT(*) FROM edges g WHERE g.object = e.id AND g.predicate = 'INVOLVED_IN') <= 1`,
    ),
  };
}
