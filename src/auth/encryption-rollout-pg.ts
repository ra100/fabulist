import type { QueryResultRow } from 'pg';
import type { Queryable } from '../db/pg.ts';
import type { SessionUser } from './config.ts';

export interface EncryptionRolloutState {
  enabled: boolean;
  encryptNewStories: boolean;
}

const ROLLOUT_OFF: EncryptionRolloutState = { enabled: false, encryptNewStories: false };

interface RolloutRow extends QueryResultRow {
  enabled: boolean;
  encrypt_new_stories: boolean;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Resolves this user's rollout state and binds an email-seeded pilot row to the
 * stable WorkOS user id on first login.
 *
 * The bind is deliberately one-way (`WHERE user_id IS NULL`): a row that has
 * already been claimed by one identity must not silently move to another just
 * because they now present the same email.
 */
export async function resolveEncryptionRollout(
  db: Queryable,
  user: SessionUser | null,
): Promise<EncryptionRolloutState> {
  if (!user) return ROLLOUT_OFF;

  // First prefer an existing user-id binding, so an email change in WorkOS does
  // not disable the rollout for an already-enrolled identity.
  const byId = await db.query<RolloutRow>(
    `SELECT enabled, encrypt_new_stories
       FROM encryption_rollout
      WHERE user_id = $1
      LIMIT 1`,
    [user.id],
  );
  if (byId.rows[0]) {
    return {
      enabled: !!byId.rows[0].enabled,
      encryptNewStories: !!byId.rows[0].encrypt_new_stories,
    };
  }

  const email = normaliseEmail(user.email);
  if (!email) return ROLLOUT_OFF;

  // First login for a bootstrap-email entry: claim it for this user id.
  await db.query(
    `UPDATE encryption_rollout
        SET user_id = $1,
            bound_at = COALESCE(bound_at, now()),
            updated_at = now()
      WHERE user_id IS NULL
        AND bootstrap_email = $2`,
    [user.id, email],
  );

  const bound = await db.query<RolloutRow>(
    `SELECT enabled, encrypt_new_stories
       FROM encryption_rollout
      WHERE user_id = $1
      LIMIT 1`,
    [user.id],
  );
  if (!bound.rows[0]) return ROLLOUT_OFF;
  return {
    enabled: !!bound.rows[0].enabled,
    encryptNewStories: !!bound.rows[0].encrypt_new_stories,
  };
}

/** Adds rollout flags onto the request user object for downstream routing decisions. */
export async function withEncryptionRollout(db: Queryable, user: SessionUser | null): Promise<SessionUser | null> {
  if (!user) return null;
  const rollout = await resolveEncryptionRollout(db, user);
  return {
    ...user,
    encryptionPilot: rollout.enabled,
    encryptNewStories: rollout.enabled && rollout.encryptNewStories,
  };
}

