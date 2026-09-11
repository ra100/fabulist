/**
 * Who may see and change which world.
 *
 * ## Why this is application code rather than database roles
 *
 * `schema-pg-roles.sql` already separates user data from system data: a
 * `fabulist_play` connection physically cannot write `canon_entities`, no matter
 * what a route asks it to do. That is the boundary worth enforcing in the
 * database, because it is one rule for every connection and it protects the
 * irreplaceable thing.
 *
 * "May Alice see the Star Trek world" is a different question. It changes per row
 * and per user, and encoding it as database roles would mean a Postgres role per
 * human — which does not scale, cannot be changed inside a transaction that is
 * also doing application work, and puts authorisation somewhere no test can reach
 * cheaply. So it lives here, is checked by the routes, and is tested directly.
 *
 * ## What a check is allowed to cost
 *
 * `worldsVisibleTo` is called on every request that lists worlds, and
 * `assertWorldAccess` on every mutation of one. Both are single queries with no
 * per-world loop: the visibility rule is expressible in SQL, so it is expressed in
 * SQL rather than fetched and filtered in JS. A per-world round trip here would be
 * paid on the busiest read in the world picker.
 */
import type { Queryable } from '../db/pg.ts';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../auth/config.ts';
import { decryptStoryValue, encryptStoryValue } from '../crypto/story-envelope.ts';
import type { ChronicleCrypto } from './chronicle-pg.ts';

/** What a user may do with a world, in increasing order of power. */
export type WorldRole = 'reader' | 'ingest' | 'owner';

/**
 * The rank of each role, so a check can ask "at least this much" without a
 * switch. `reader` is also what a public world grants implicitly.
 */
const RANK: Record<WorldRole, number> = { reader: 1, ingest: 2, owner: 3 };

/**
 * The user id used when login is off.
 *
 * Empty string rather than null, matching `stories.owner_user_id` and
 * `prose_blocklist.user_id`: one person on one laptop has no identity to record,
 * and a nullable key would make every `PRIMARY KEY (world_id, user_id)` lookup a
 * three-valued comparison.
 */
export const LOCAL_USER = '';

function idOf(user: SessionUser | null | undefined): string {
  return user?.id ?? LOCAL_USER;
}

export interface WorldAccess {
  worldId: number;
  slug: string;
  title: string;
  visibility: 'public' | 'private';
  /** The caller's effective role, or null when they may not see it at all. */
  role: WorldRole | null;
}

/**
 * Every world this user may read, with their effective role on each.
 *
 * One query. The `LEFT JOIN` plus the visibility test is the whole rule:
 *
 *   - an explicit `world_access` row always wins, whatever the visibility;
 *   - a public world with no row grants `reader`;
 *   - a private world with no row is not returned at all.
 *
 * An admin sees everything, because an admin is the person who has to fix a world
 * nobody else can reach — the same reasoning `requireAdmin` already applies to
 * system settings.
 */
export async function worldsVisibleTo(
  db: Queryable,
  user: SessionUser | null | undefined,
): Promise<WorldAccess[]> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    title: string;
    visibility: 'public' | 'private';
    role: WorldRole | null;
  }>(
    `SELECT w.id, w.slug, w.title, w.visibility,
            -- Precedence must match \`worldRoleFor\` exactly: an explicit grant always
            -- wins; absent one, an admin gets 'owner' (checked in SQL, not only in the
            -- JS fallback below) so a public world with no \`world_access\` row does not
            -- collapse to 'reader' for an admin before the fallback ever runs — that
            -- silently downgraded every freshly-ingested world's rename/visibility/
            -- delete controls for every admin, since a new world starts public with no
            -- grant row at all.
            COALESCE(a.role, CASE WHEN $2 THEN 'owner' WHEN w.visibility = 'public' THEN 'reader' END) AS role
       FROM worlds w
       LEFT JOIN world_access a ON a.world_id = w.id AND a.user_id = $1
      WHERE $2 OR a.role IS NOT NULL OR w.visibility = 'public'
      ORDER BY w.slug`,
    [idOf(user), user?.isAdmin === true],
  );
  return rows.map((r) => ({
    worldId: Number(r.id),
    slug: r.slug,
    title: r.title,
    visibility: r.visibility,
    role: r.role,
  }));
}

/** The caller's effective role on one world, or null if they may not see it. */
export async function worldRoleFor(
  db: Queryable,
  user: SessionUser | null | undefined,
  worldId: number,
): Promise<WorldRole | null> {
  const { rows } = await db.query<{ visibility: 'public' | 'private'; role: WorldRole | null }>(
    `SELECT w.visibility, a.role
       FROM worlds w
       LEFT JOIN world_access a ON a.world_id = w.id AND a.user_id = $2
      WHERE w.id = $1`,
    [worldId, idOf(user)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.role) return row.role;
  if (user?.isAdmin === true) return 'owner';
  return row.visibility === 'public' ? 'reader' : null;
}

/**
 * Throws unless the caller has at least `needed` on this world.
 *
 * The message deliberately does not distinguish "this world is private" from "this
 * world does not exist" when the caller has no access at all: telling an
 * unauthorised user that a named world exists is the leak, not a courtesy.
 * Distinguishing *within* the roles is fine — someone who can already see the
 * world learns nothing new from being told they cannot ingest into it.
 */
export async function assertWorldAccess(
  db: Queryable,
  user: SessionUser | null | undefined,
  worldId: number,
  needed: WorldRole,
): Promise<WorldRole> {
  const role = await worldRoleFor(db, user, worldId);
  if (!role) throw new Error(`no world ${worldId}`);
  if (RANK[role] < RANK[needed]) {
    throw new Error(`this world requires ${needed} access; you have ${role}`);
  }
  return role;
}

/**
 * Grants a role, or replaces an existing one.
 *
 * Idempotent, so the caller does not have to know whether a row already exists —
 * the common case is "make sure this user can read this world", not "insert
 * exactly once".
 */
export async function grantWorldAccess(
  db: Queryable,
  worldId: number,
  userId: string,
  role: WorldRole = 'reader',
): Promise<void> {
  await db.query(
    `INSERT INTO world_access (world_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (world_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_at = now()`,
    [worldId, userId, role],
  );
}

/** Revokes an explicit grant. A public world stays readable; a private one does not. */
export async function revokeWorldAccess(db: Queryable, worldId: number, userId: string): Promise<void> {
  await db.query(`DELETE FROM world_access WHERE world_id = $1 AND user_id = $2`, [worldId, userId]);
}

/** Everyone with an explicit grant on this world. */
export async function worldGrants(
  db: Queryable,
  worldId: number,
): Promise<Array<{ userId: string; role: WorldRole; grantedAt: string }>> {
  const { rows } = await db.query<{ user_id: string; role: WorldRole; granted_at: Date }>(
    `SELECT user_id, role, granted_at FROM world_access WHERE world_id = $1 ORDER BY granted_at`,
    [worldId],
  );
  return rows.map((r) => ({ userId: r.user_id, role: r.role, grantedAt: r.granted_at.toISOString() }));
}

/**
 * Makes a world public or private.
 *
 * Going private does not add grants for whoever was already reading it. That is
 * deliberate and the safer direction to get wrong: the point of going private is to
 * stop people reading, so silently preserving existing readers would defeat it.
 * Their *stories* keep working — `story_sources` is a foreign key, not a
 * permission — which is the right outcome: nobody's writing breaks because a world
 * they used was locked down, they just cannot start a new story against it.
 */
export async function setWorldVisibility(
  db: Queryable,
  worldId: number,
  visibility: 'public' | 'private',
): Promise<void> {
  const { rowCount } = await db.query(`UPDATE worlds SET visibility = $2 WHERE id = $1`, [worldId, visibility]);
  if (!rowCount) throw new Error(`no world ${worldId}`);
}

// --------------------------------------------------------------- blocklist

export interface BlockedPhrase {
  pattern: string;
  note: string;
}

export interface StoryBlocklistOptions {
  storyId: string;
  crypto?: ChronicleCrypto;
}

const PRIVATE_BLOCKLIST_PREFIX = 'private:';

async function privateStoryKey(
  db: Queryable,
  storyId: string,
  crypto: ChronicleCrypto | undefined,
): Promise<Buffer | null> {
  const { rows } = await db.query<{ encryption_version: number }>(
    `SELECT encryption_version FROM stories WHERE id = $1`,
    [storyId],
  );
  const version = rows[0]?.encryption_version;
  if (version === undefined) throw new Error(`no story ${storyId}`);
  if (version !== 0 && version !== 1) throw new Error(`unsupported private-story format ${version}`);
  if (version === 0) return null;
  const key = crypto?.keyForStory(storyId) ?? null;
  if (!key) throw new Error(`private story ${storyId} is locked`);
  if (key.length !== 32) throw new Error('invalid private-story key');
  return Buffer.from(key);
}

function privateRecordPrefix(storyId: string): string {
  return `${PRIVATE_BLOCKLIST_PREFIX}${storyId}:`;
}

async function privateBlocklistFor(
  db: Queryable,
  userId: string,
  storyId: string,
  key: Buffer,
): Promise<Array<BlockedPhrase & { id: string }>> {
  const { rows } = await db.query<{ pattern: string }>(
    `SELECT pattern FROM prose_blocklist WHERE user_id = $1 AND pattern LIKE $2 ORDER BY added`,
    [userId, `${privateRecordPrefix(storyId)}%`],
  );
  if (!rows.length) return [];
  const recordIds = rows.map((row) => row.pattern);
  const { rows: encrypted } = await db.query<{
    record_id: string;
    field_name: string;
    version: number;
    nonce: Buffer;
    ciphertext: Buffer;
  }>(
    `SELECT record_id, field_name, version, nonce, ciphertext
       FROM encrypted_story_values
      WHERE story_id = $1 AND table_name = 'prose_blocklist'
        AND record_id = ANY($2::text[]) AND field_name IN ('pattern', 'note')`,
    [storyId, recordIds],
  );
  const values = new Map<string, Map<string, unknown>>();
  for (const row of encrypted) {
    const fields = values.get(row.record_id) ?? new Map<string, unknown>();
    fields.set(
      row.field_name,
      decryptStoryValue(
        key,
        { storyId, table: 'prose_blocklist', recordId: row.record_id, field: row.field_name },
        { version: row.version, nonce: row.nonce, ciphertext: row.ciphertext },
      ),
    );
    values.set(row.record_id, fields);
  }
  return recordIds.map((id) => {
    const fields = values.get(id);
    const pattern = fields?.get('pattern');
    const note = fields?.get('note');
    if (typeof pattern !== 'string' || typeof note !== 'string') {
      throw new Error('missing encrypted private story value prose_blocklist');
    }
    return { id, pattern, note };
  });
}

async function writePrivateBlocklist(
  db: Queryable,
  userId: string,
  storyId: string,
  key: Buffer,
  id: string,
  pattern: string,
  note: string,
): Promise<void> {
  const fields = [
    { field: 'pattern', ...encryptStoryValue(key, { storyId, table: 'prose_blocklist', recordId: id, field: 'pattern' }, pattern) },
    { field: 'note', ...encryptStoryValue(key, { storyId, table: 'prose_blocklist', recordId: id, field: 'note' }, note) },
  ];
  await db.query(
    `WITH written AS (
       INSERT INTO prose_blocklist (user_id, pattern, note) VALUES ($1,$2,'')
       ON CONFLICT (user_id, pattern) DO UPDATE SET note = ''
       RETURNING 1
     )
     INSERT INTO encrypted_story_values (story_id, table_name, record_id, field_name, version, nonce, ciphertext)
     SELECT $3, 'prose_blocklist', $2, value.field_name, value.version, value.nonce, value.ciphertext
       FROM written CROSS JOIN (VALUES
         ($4::text,$5::integer,$6::bytea,$7::bytea),
         ($8::text,$9::integer,$10::bytea,$11::bytea)
       ) AS value(field_name, version, nonce, ciphertext)
     ON CONFLICT (story_id, table_name, record_id, field_name) DO UPDATE SET
       version = EXCLUDED.version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [
      userId, id, storyId,
      fields[0]!.field, fields[0]!.version, fields[0]!.nonce, fields[0]!.ciphertext,
      fields[1]!.field, fields[1]!.version, fields[1]!.nonce, fields[1]!.ciphertext,
    ],
  );
}

/**
 * This user's personal prose blocklist.
 *
 * Per user, because a phrase one player is tired of is not a property of the
 * server. The SQLite table was global — and, as its schema comment records, read by
 * nothing in `src/`: `config.blocklist` was what actually fed the linter, so the
 * table was dead weight that looked like a feature. Scoping it correctly cost
 * nothing, and this is the code that makes it real.
 */
export async function blocklistFor(
  db: Queryable,
  user: SessionUser | null | undefined,
  opts?: StoryBlocklistOptions,
): Promise<BlockedPhrase[]> {
  if (opts) {
    const key = await privateStoryKey(db, opts.storyId, opts.crypto);
    if (key) return (await privateBlocklistFor(db, idOf(user), opts.storyId, key)).map(({ pattern, note }) => ({ pattern, note }));
  }
  const { rows } = await db.query<{ pattern: string; note: string }>(
    `SELECT pattern, note FROM prose_blocklist WHERE user_id = $1 ORDER BY added`,
    [idOf(user)],
  );
  return rows;
}

/** Adds a phrase, or updates its note. */
export async function blockPhrase(
  db: Queryable,
  user: SessionUser | null | undefined,
  pattern: string,
  note = '',
  opts?: StoryBlocklistOptions,
): Promise<void> {
  const trimmed = pattern.trim();
  if (!trimmed) throw new Error('a blocked phrase cannot be empty');
  if (opts) {
    const key = await privateStoryKey(db, opts.storyId, opts.crypto);
    if (key) {
      const entries = await privateBlocklistFor(db, idOf(user), opts.storyId, key);
      const existing = entries.find((entry) => entry.pattern === trimmed);
      await writePrivateBlocklist(
        db,
        idOf(user),
        opts.storyId,
        key,
        existing?.id ?? `${privateRecordPrefix(opts.storyId)}${randomUUID()}`,
        trimmed,
        note,
      );
      return;
    }
  }
  await db.query(
    `INSERT INTO prose_blocklist (user_id, pattern, note) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, pattern) DO UPDATE SET note = EXCLUDED.note`,
    [idOf(user), trimmed, note],
  );
}

export async function unblockPhrase(
  db: Queryable,
  user: SessionUser | null | undefined,
  pattern: string,
  opts?: StoryBlocklistOptions,
): Promise<void> {
  if (opts) {
    const key = await privateStoryKey(db, opts.storyId, opts.crypto);
    if (key) {
      const entry = (await privateBlocklistFor(db, idOf(user), opts.storyId, key)).find(
        (candidate) => candidate.pattern === pattern.trim(),
      );
      if (!entry) return;
      await db.query(
        `DELETE FROM encrypted_story_values
          WHERE story_id = $1 AND table_name = 'prose_blocklist' AND record_id = $2`,
        [opts.storyId, entry.id],
      );
      await db.query(`DELETE FROM prose_blocklist WHERE user_id = $1 AND pattern = $2`, [idOf(user), entry.id]);
      return;
    }
  }
  await db.query(`DELETE FROM prose_blocklist WHERE user_id = $1 AND pattern = $2`, [idOf(user), pattern.trim()]);
}
