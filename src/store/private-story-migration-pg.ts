import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  decryptStoryBytes,
  decryptStoryValue,
  encryptStoryBytes,
  encryptStoryValue,
  storyBlindIndex,
  type StoryValueEnvelope,
} from '../crypto/story-envelope.ts';
import type { Db, Queryable } from '../db/pg.ts';
import { normaliseLogicalId, normaliseNameForIndex } from './graph-pg.ts';

type Field = { name: string; value: (row: Record<string, unknown>) => unknown };
type Surface = {
  name: string;
  select: string;
  id: (row: Record<string, unknown>) => string;
  fields: Field[];
  clear: string;
};

interface StoryMigrationRow {
  id: string;
  encryption_version: number;
  migration_status: 'migrating' | 'failed' | 'complete' | null;
}

interface EncryptedRow extends StoryValueEnvelope {
  field_name: string;
}

const PRIVATE_BLOCKLIST_PREFIX = 'private:';
const direct = (name: string): Field => ({ name, value: (row) => row[name] });

/**
 * Only fields that their owning stores read from encrypted_story_values belong
 * here. Stable entity/location IDs and other structural metadata deliberately
 * remain in their base columns.
 */
const surfaces: Surface[] = [
  {
    name: 'stories',
    select: 'SELECT id, title, player_character_id, current_location_id, style, knobs FROM stories WHERE id = $1',
    id: (row) => String(row.id),
    fields: [
      direct('title'),
      direct('player_character_id'),
      direct('current_location_id'),
      direct('style'),
      direct('knobs'),
    ],
    clear: `UPDATE stories
              SET title = '', player_character_id = '', current_location_id = NULL,
                  style = '{}', knobs = '{}'
            WHERE id = $1`,
  },
  {
    name: 'turns',
    select: 'SELECT id, raw_input, intent, delta, book_prose, meta FROM turns WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('raw_input'), direct('intent'), direct('delta'), direct('book_prose'), direct('meta')],
    clear: `UPDATE turns
              SET raw_input = '', intent = NULL, delta = NULL, book_prose = '', meta = '{}'
            WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'events',
    select: 'SELECT id, text FROM events WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('text')],
    clear: `UPDATE events SET text = '' WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'facts',
    select: 'SELECT id, text FROM facts WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('text')],
    clear: `UPDATE facts SET text = '' WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'scenes',
    select: 'SELECT scene::text id, title, summary FROM scenes WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('title'), direct('summary')],
    clear: `UPDATE scenes SET title = '', summary = '' WHERE story_id = $2 AND scene::text = $1`,
  },
  {
    name: 'chapters',
    select: 'SELECT chapter::text id, title, summary FROM chapters WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('title'), direct('summary')],
    clear: `UPDATE chapters SET title = '', summary = '' WHERE story_id = $2 AND chapter::text = $1`,
  },
  {
    name: 'divergences',
    select: 'SELECT id::text id, detail, canon FROM divergences WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('detail'), direct('canon')],
    clear: `UPDATE divergences SET detail = '', canon = '' WHERE story_id = $2 AND id::text = $1`,
  },
  {
    name: 'style_anchors',
    select: 'SELECT id::text id, text, note FROM style_anchors WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('text'), direct('note')],
    clear: `UPDATE style_anchors SET text = '', note = '' WHERE story_id = $2 AND id::text = $1`,
  },
  {
    name: 'threads',
    select: 'SELECT id, title, stakes, parties, resolutions FROM threads WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('title'), direct('stakes'), direct('parties'), direct('resolutions')],
    clear: `UPDATE threads
              SET title = '', stakes = '', parties = '[]', resolutions = '[]'
            WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'consequences',
    select: 'SELECT id, trigger, action FROM consequences WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('trigger'), direct('action')],
    clear: `UPDATE consequences SET trigger = '{}', action = '' WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'directives',
    select: 'SELECT id, text FROM directives WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('text')],
    clear: `UPDATE directives SET text = '' WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'chron_sheets',
    select: `SELECT entity_id id, identity, contract, voice, condition, appearance, locks
               FROM chron_sheets WHERE story_id = $1`,
    id: (row) => String(row.id),
    fields: [
      direct('identity'),
      direct('contract'),
      direct('voice'),
      direct('condition'),
      direct('appearance'),
      direct('locks'),
    ],
    clear: `UPDATE chron_sheets
              SET identity = '{}', contract = '{}', voice = '{}',
                  condition = '{}', appearance = '{}', locks = '[]'
            WHERE entity_id = $1 AND story_id = $2`,
  },
  {
    name: 'relationships',
    select: 'SELECT from_id, to_id, note FROM relationships WHERE story_id = $1',
    id: (row) => JSON.stringify([row.from_id, row.to_id]),
    fields: [direct('note')],
    clear: `UPDATE relationships SET note = ''
            WHERE story_id = $2
              AND from_id = ($1::jsonb ->> 0)
              AND to_id = ($1::jsonb ->> 1)`,
  },
  {
    name: 'chron_entities',
    select: 'SELECT id, name, summary, props FROM chron_entities WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('name'), direct('summary'), direct('props'), { name: 'logical_id', value: (row) => row.id }],
    clear: `UPDATE chron_entities SET name = '', summary = '', props = '{}'
            WHERE id = $1 AND story_id = $2`,
  },
  {
    name: 'chron_edges',
    select: 'SELECT eid::text id, evidence FROM chron_edges WHERE story_id = $1',
    id: (row) => `edge:${row.id}`,
    fields: [direct('evidence')],
    clear: `UPDATE chron_edges SET evidence = NULL
            WHERE story_id = $2 AND ('edge:' || eid::text) = $1`,
  },
  {
    name: 'illustrations',
    select: 'SELECT id, prompt, negative_prompt FROM illustrations WHERE story_id = $1',
    id: (row) => String(row.id),
    fields: [direct('prompt'), direct('negative_prompt')],
    clear: `UPDATE illustrations SET prompt = '', negative_prompt = ''
            WHERE id = $1 AND story_id = $2`,
  },
];

function decryptEnvelope(key: Buffer, storyId: string, table: string, recordId: string, row: EncryptedRow): unknown {
  return decryptStoryValue(
    key,
    { storyId, table, recordId, field: row.field_name },
    { version: row.version, nonce: row.nonce, ciphertext: row.ciphertext },
  );
}

async function migrateSurface(db: Db, storyId: string, key: Buffer, surface: Surface): Promise<void> {
  const { rows } = await db.query<Record<string, unknown>>(surface.select, [storyId]);
  for (const row of rows) {
    const recordId = surface.id(row);
    const existing = await db.query<EncryptedRow>(
      `SELECT field_name, version, nonce, ciphertext
         FROM encrypted_story_values
        WHERE story_id = $1 AND table_name = $2 AND record_id = $3`,
      [storyId, surface.name, recordId],
    );
    if (existing.rows.length === surface.fields.length) {
      const names = new Set(existing.rows.map(({ field_name }) => field_name));
      if (surface.fields.some(({ name }) => !names.has(name))) {
        throw new Error(`unexpected envelope fields ${surface.name}/${recordId}`);
      }
      for (const envelope of existing.rows) decryptEnvelope(key, storyId, surface.name, recordId, envelope);
      await db.query(surface.clear, surface.name === 'stories' ? [storyId] : [recordId, storyId]);
      continue;
    }
    if (existing.rows.length) throw new Error(`partial envelope ${surface.name}/${recordId}`);

    await db.tx(async (tx) => {
      for (const field of surface.fields) {
        const value = field.value(row);
        const envelope = encryptStoryValue(key, { storyId, table: surface.name, recordId, field: field.name }, value);
        await tx.query(
          `INSERT INTO encrypted_story_values
             (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [storyId, surface.name, recordId, field.name, envelope.version, envelope.nonce, envelope.ciphertext],
        );
        const check = await tx.query<EncryptedRow>(
          `SELECT field_name, version, nonce, ciphertext
             FROM encrypted_story_values
            WHERE story_id = $1 AND table_name = $2 AND record_id = $3 AND field_name = $4`,
          [storyId, surface.name, recordId, field.name],
        );
        const persisted = check.rows[0];
        if (!persisted || !isDeepStrictEqual(decryptEnvelope(key, storyId, surface.name, recordId, persisted), value)) {
          throw new Error(`verification failed ${surface.name}.${field.name}`);
        }
      }
      await tx.query(surface.clear, surface.name === 'stories' ? [storyId] : [recordId, storyId]);
    });
  }
}

async function migrateIllustrationFiles(db: Db, storyId: string, key: Buffer, imagesDir: string): Promise<void> {
  const { rows } = await db.query<{ id: string; path: string }>(
    `SELECT id, path FROM illustrations WHERE story_id = $1 AND path IS NOT NULL`,
    [storyId],
  );
  for (const row of rows) {
    const encryptedPath = row.path.endsWith('.enc') ? row.path : `${row.path}.enc`;
    const sourcePath = row.path.endsWith('.enc') ? row.path.slice(0, -4) : row.path;
    const source = join(imagesDir, sourcePath);
    const target = join(imagesDir, encryptedPath);
    const context = { storyId, table: 'illustration_files', recordId: row.id, field: 'bytes' };
    const sourceExists = existsSync(source);

    if (existsSync(target)) {
      const decrypted = decryptStoryBytes(key, context, readFileSync(target));
      if (sourceExists && !decrypted.equals(readFileSync(source))) {
        throw new Error(`encrypted illustration does not match ${sourcePath}`);
      }
    } else {
      if (!sourceExists) throw new Error(`missing illustration file ${sourcePath}`);
      const plaintext = readFileSync(source);
      const encrypted = encryptStoryBytes(key, context, plaintext);
      if (!decryptStoryBytes(key, context, encrypted).equals(plaintext)) {
        throw new Error(`illustration verification failed ${sourcePath}`);
      }
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, encrypted, { flag: 'wx' });
        decryptStoryBytes(key, context, readFileSync(temporary));
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }

    await db.query(`UPDATE illustrations SET path = $1 WHERE id = $2 AND story_id = $3`, [
      encryptedPath,
      row.id,
      storyId,
    ]);
    if (source !== target && existsSync(source)) unlinkSync(source);
  }
}

async function migrateGraphIndexes(db: Db, storyId: string, key: Buffer): Promise<void> {
  const entities = await db.query<{
    id: string;
    version: number;
    nonce: Buffer;
    ciphertext: Buffer;
  }>(
    `SELECT e.id, v.version, v.nonce, v.ciphertext
       FROM chron_entities e
       JOIN encrypted_story_values v
         ON v.story_id = e.story_id
        AND v.table_name = 'chron_entities'
        AND v.record_id = e.id
        AND v.field_name = 'name'
      WHERE e.story_id = $1`,
    [storyId],
  );
  for (const entity of entities.rows) {
    const name = decryptStoryValue(
      key,
      { storyId, table: 'chron_entities', recordId: entity.id, field: 'name' },
      entity,
    );
    if (typeof name !== 'string') throw new Error('invalid migrated entity name');
    await db.query(
      `INSERT INTO chron_entity_blind_indexes (story_id, entity_id, index_kind, token)
       VALUES ($1,$2,'name',$3),($1,$2,'logical_id',$4)
       ON CONFLICT (story_id, entity_id, index_kind) DO UPDATE SET token = EXCLUDED.token`,
      [
        storyId,
        entity.id,
        storyBlindIndex(key, 'graph:name', normaliseNameForIndex(name)),
        storyBlindIndex(key, 'graph:logical-id', normaliseLogicalId(entity.id)),
      ],
    );
  }
}

async function legacyBlocklist(db: Queryable, userId: string): Promise<Array<{ pattern: string; note: string }>> {
  const { rows } = await db.query<{ pattern: string; note: string }>(
    `SELECT b.pattern, b.note
       FROM prose_blocklist b
      WHERE b.user_id = $1
        AND NOT EXISTS (
          SELECT 1
            FROM encrypted_story_values v
           WHERE v.table_name = 'prose_blocklist' AND v.record_id = b.pattern
        )
      ORDER BY b.added`,
    [userId],
  );
  return rows;
}

async function verifyPrivateBlocklist(db: Queryable, storyId: string, key: Buffer): Promise<void> {
  const prefix = `${PRIVATE_BLOCKLIST_PREFIX}${storyId}:`;
  const records = await db.query<{ record_id: string }>(
    `SELECT pattern record_id FROM prose_blocklist WHERE pattern LIKE $1 ORDER BY pattern`,
    [`${prefix}%`],
  );
  if (!records.rows.length) return;
  const { rows } = await db.query<EncryptedRow & { record_id: string }>(
    `SELECT record_id, field_name, version, nonce, ciphertext
       FROM encrypted_story_values
      WHERE story_id = $1 AND table_name = 'prose_blocklist'
        AND record_id = ANY($2::text[])
      ORDER BY record_id, field_name`,
    [storyId, records.rows.map(({ record_id }) => record_id)],
  );
  const fields = new Map(records.rows.map(({ record_id }) => [record_id, new Set<string>()]));
  for (const row of rows) {
    decryptEnvelope(key, storyId, 'prose_blocklist', row.record_id, row);
    fields.get(row.record_id)!.add(row.field_name);
  }
  for (const [recordId, names] of fields) {
    if (names.size !== 2 || !names.has('pattern') || !names.has('note')) {
      throw new Error(`partial envelope prose_blocklist/${recordId}`);
    }
  }
}

async function migrateLegacyBlocklist(
  db: Db,
  userId: string,
  stories: StoryMigrationRow[],
  keys: Map<string, Buffer>,
): Promise<void> {
  const legacy = await legacyBlocklist(db, userId);
  if (legacy.length) {
    await db.tx(async (tx) => {
      for (const block of legacy) {
        for (const story of stories) {
          const key = keys.get(story.id)!;
          const recordId = `${PRIVATE_BLOCKLIST_PREFIX}${story.id}:${storyBlindIndex(
            key,
            'blocklist:record',
            block.pattern,
          )}`;
          await tx.query(
            `INSERT INTO prose_blocklist (user_id, pattern, note)
             VALUES ($1,$2,'')
             ON CONFLICT (user_id, pattern) DO UPDATE SET note = ''`,
            [userId, recordId],
          );
          for (const [field, value] of [
            ['pattern', block.pattern],
            ['note', block.note],
          ] as const) {
            const envelope = encryptStoryValue(
              key,
              { storyId: story.id, table: 'prose_blocklist', recordId, field },
              value,
            );
            await tx.query(
              `INSERT INTO encrypted_story_values
                 (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
               VALUES ($1,'prose_blocklist',$2,$3,$4,$5,$6)
               ON CONFLICT (story_id, table_name, record_id, field_name) DO UPDATE SET
                 version = EXCLUDED.version, nonce = EXCLUDED.nonce,
                 ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
              [story.id, recordId, field, envelope.version, envelope.nonce, envelope.ciphertext],
            );
            const persisted = await tx.query<EncryptedRow>(
              `SELECT field_name, version, nonce, ciphertext
                 FROM encrypted_story_values
                WHERE story_id = $1 AND table_name = 'prose_blocklist'
                  AND record_id = $2 AND field_name = $3`,
              [story.id, recordId, field],
            );
            const encrypted = persisted.rows[0];
            if (!encrypted || decryptEnvelope(key, story.id, 'prose_blocklist', recordId, encrypted) !== value) {
              throw new Error('blocklist verification failed');
            }
          }
        }
      }
      await tx.query(`DELETE FROM prose_blocklist WHERE user_id = $1 AND pattern = ANY($2::text[])`, [
        userId,
        legacy.map(({ pattern }) => pattern),
      ]);
      await tx.query(
        `UPDATE user_private_story_migrations
            SET blocklist_done = true, updated_at = now()
          WHERE user_id = $1`,
        [userId],
      );
    });
  }
  for (const story of stories) await verifyPrivateBlocklist(db, story.id, keys.get(story.id)!);
}

async function claimMigration(
  db: Db,
  userId: string,
  stories: StoryMigrationRow[],
  pending: StoryMigrationRow[],
): Promise<void> {
  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO user_private_story_migrations (user_id, status, blocklist_done)
       VALUES ($1, 'migrating', false)
       ON CONFLICT (user_id) DO UPDATE SET
         status = 'migrating', error = NULL, blocklist_done = false, updated_at = now()`,
      [userId],
    );
    for (const story of pending) {
      await tx.query(
        `INSERT INTO story_private_story_migrations (story_id, user_id, status, category)
         VALUES ($1,$2,'migrating','starting')
         ON CONFLICT (story_id) DO UPDATE SET
           user_id = EXCLUDED.user_id, status = 'migrating',
           category = 'starting', error = NULL, updated_at = now()`,
        [story.id, userId],
      );
    }
    if (!stories.length) throw new Error('no private stories to migrate');
  });
}

async function storyRows(db: Queryable, userId: string): Promise<StoryMigrationRow[]> {
  const { rows } = await db.query<StoryMigrationRow>(
    `SELECT s.id, s.encryption_version, m.status migration_status
       FROM stories s
       LEFT JOIN story_private_story_migrations m ON m.story_id = s.id
      WHERE s.owner_user_id = $1
      ORDER BY s.id`,
    [userId],
  );
  return rows;
}

async function pendingStories(db: Queryable, stories: StoryMigrationRow[]): Promise<StoryMigrationRow[]> {
  const pending: StoryMigrationRow[] = [];
  for (const story of stories) {
    if (story.encryption_version === 0) {
      if (story.migration_status === 'complete') {
        throw new Error(`story ${story.id} has an invalid completed plaintext checkpoint`);
      }
      pending.push(story);
      continue;
    }
    if (story.encryption_version !== 1) {
      throw new Error(`story ${story.id} has unsupported encryption version ${story.encryption_version}`);
    }
    if (story.migration_status === 'complete') continue;
    if (story.migration_status) {
      pending.push(story);
      continue;
    }
    const encrypted = await db.query<{ count: string }>(
      `SELECT count(*)::text count FROM encrypted_story_values WHERE story_id = $1`,
      [story.id],
    );
    const indexes = await db.query<{ count: string }>(
      `SELECT count(*)::text count FROM chron_entity_blind_indexes WHERE story_id = $1`,
      [story.id],
    );
    if (Number(encrypted.rows[0]?.count ?? 0) || Number(indexes.rows[0]?.count ?? 0)) {
      throw new Error(`story ${story.id} is v1 without a verified migration checkpoint`);
    }
    // Early rollout builds incorrectly marked plaintext stories as v1. An
    // entirely absent encrypted representation is positive evidence of that
    // known state; mixed or partial v1 data is rejected above.
    pending.push(story);
  }
  return pending;
}

export async function migratePrivateStories(
  db: Db,
  userId: string,
  keys: Map<string, Buffer>,
  imagesDir: string,
): Promise<void> {
  const lockName = `fabulist:private-story-migration:${userId}`;
  const lockClient = await db.pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) locked`,
      [lockName],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new Error('private story migration is already running');

    const owned = await storyRows(db, userId);
    if (!owned.length) throw new Error('no private stories to migrate');
    const missing = owned.filter((story) => !keys.has(story.id)).map((story) => story.id);
    if (missing.length) throw new Error(`missing active keys for: ${missing.join(', ')}`);
    const pending = await pendingStories(db, owned);
    const legacy = await legacyBlocklist(db, userId);
    const prior = await privateMigrationStatus(db, userId);
    if (!pending.length && !legacy.length && prior?.status === 'complete') return;

    await claimMigration(db, userId, owned, pending);
    try {
      for (const story of pending) {
        const key = keys.get(story.id)!;
        for (const surface of surfaces) {
          await migrateSurface(db, story.id, key, surface);
          await db.query(
            `UPDATE story_private_story_migrations
                SET category = $2, updated_at = now()
              WHERE story_id = $1`,
            [story.id, surface.name],
          );
        }
        await migrateIllustrationFiles(db, story.id, key, imagesDir);
        await migrateGraphIndexes(db, story.id, key);
        await db.query(
          `UPDATE story_private_story_migrations
              SET category = 'blocklist', updated_at = now()
            WHERE story_id = $1`,
          [story.id],
        );
      }

      await migrateLegacyBlocklist(db, userId, owned, keys);
      await db.tx(async (tx) => {
        if (pending.length) {
          const ids = pending.map(({ id }) => id);
          await tx.query(`UPDATE stories SET encryption_version = 1 WHERE id = ANY($1::text[])`, [ids]);
          await tx.query(
            `UPDATE story_private_story_migrations
                SET status = 'complete', category = 'complete', error = NULL, updated_at = now()
              WHERE story_id = ANY($1::text[])`,
            [ids],
          );
        }
        await tx.query(
          `UPDATE user_private_story_migrations
              SET status = 'complete', error = NULL, blocklist_done = true, updated_at = now()
            WHERE user_id = $1`,
          [userId],
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'private story migration failed';
      await db.tx(async (tx) => {
        await tx.query(
          `UPDATE story_private_story_migrations
              SET status = 'failed', error = $2, updated_at = now()
            WHERE user_id = $1 AND status = 'migrating'`,
          [userId, message],
        );
        await tx.query(
          `UPDATE user_private_story_migrations
              SET status = 'failed', error = $2, updated_at = now()
            WHERE user_id = $1`,
          [userId, message],
        );
      });
      throw error;
    }
  } finally {
    try {
      if (locked) {
        await lockClient.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockName]);
      }
    } finally {
      lockClient.release();
    }
  }
}

export async function privateMigrationStatus(db: Queryable, userId: string) {
  const result = await db.query<{ status: string; error: string | null; blocklist_done: boolean }>(
    `SELECT status, error, blocklist_done
       FROM user_private_story_migrations
      WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export class PrivateStoryMigrationIncompleteError extends Error {}

export async function assertPrivateStoryMigrationReady(db: Queryable, storyId: string): Promise<void> {
  const result = await db.query<{ status: string }>(
    `SELECT status FROM story_private_story_migrations WHERE story_id = $1`,
    [storyId],
  );
  if (result.rows[0] && result.rows[0].status !== 'complete') {
    throw new PrivateStoryMigrationIncompleteError(
      'private story migration is incomplete; unlock and resume it before accessing content',
    );
  }
}

export async function assertPrivateStoryCreationReady(db: Queryable, userId: string): Promise<void> {
  const result = await db.query<{ blocked: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM user_encryption_keys WHERE user_id = $1)
       OR EXISTS (
         SELECT 1 FROM user_private_story_migrations
          WHERE user_id = $1 AND status = 'complete'
       )
     ) blocked`,
    [userId],
  );
  if (result.rows[0]?.blocked) {
    throw new Error(
      'creating, claiming, or forking a private story requires browser key provisioning, which is not available yet',
    );
  }
}
