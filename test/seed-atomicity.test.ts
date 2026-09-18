import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../src/store/index.ts';
import { seedWorld } from '../src/seed/verrow.ts';

test('sample seed rolls back all SQLite writes when a later write fails', () => {
  const world = World.open(':memory:');
  world.db.exec(`
    CREATE TRIGGER reject_seed_edge
    BEFORE INSERT ON edges
    WHEN NEW.subject = 'char:brother-anselm'
    BEGIN
      SELECT RAISE(ABORT, 'injected seed failure');
    END;
  `);

  assert.throws(() => seedWorld(world), /injected seed failure/);
  const entities = world.db.prepare('SELECT count(*) AS n FROM entities').get() as { n: number };
  const meta = world.db.prepare('SELECT count(*) AS n FROM meta').get() as { n: number };
  assert.equal(entities.n, 0);
  assert.equal(meta.n, 0);
  world.close();
});
