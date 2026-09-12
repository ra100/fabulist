# Task 1 report — immutable turn history

## Status

DONE_WITH_CONCERNS

## Files changed

- `src/domain/types.ts`
- `src/store/history.ts`
- `src/store/history-pg.ts`
- `src/store/index.ts`
- `src/store/index-pg.ts`
- `src/db/schema.sql`
- `src/db/db.ts`
- `src/db/schema-pg.sql`
- `src/db/schema-pg-roles.sql`
- `src/db/migrations-pg/006-turn-history.sql`
- `test/history.test.ts`
- `test/pg-history.test.ts`

## Design decisions

- Added immutable checkpoint metadata keyed by checkpoint ID, with one checkpoint
  per `(story_id, turn_id)` and monotonic story-local positions. Legacy turns
  retain null history fields and are not eligible.
- Checkpoint layouts contain the mutable story projection only: chronicle rows,
  state tables, illustrations, and the session cursor. Canon, world metadata,
  story sources, aliases, and other stories are excluded by explicit
  story-scoped queries.
- Checkpoint restoration is transactional and restores that projection without
  deleting immutable turn/checkpoint records; Task 2 owns pruning later turns
  and history during rollback.
- Added durable `scene_segments`, initially assigning the first captured turn
  to an initial segment. `splitBefore` validates exact-history eligibility,
  persists a boundary, and updates segment membership without beginning Task 2
  presentation/summarisation regrouping.
- PostgreSQL private checkpoint state is always encrypted using
  `encryptStoryValue` under the `history_checkpoints`/checkpoint-ID AAD
  context. Public checkpoint state is JSONB; private base state is `{}` and
  only its authenticated envelope is persisted. Locked private stories reject
  checkpoint reads and writes.
- PostgreSQL checkpoint operations use `Db.tx` when available and otherwise
  operate through their supplied transactional `Queryable`, preserving callers'
  transaction context.

## Validation

- `rtk pnpm typecheck` — PASS.
- `rtk pnpm exec biome check src/store/history.ts src/store/history-pg.ts test/history.test.ts test/pg-history.test.ts` — PASS.
- `rtk pnpm test --test-name-pattern='history checkpoint|legacy turn'` — PASS;
  SQLite history tests passed and PostgreSQL tests reported the established
  skip because `FABULIST_TEST_PG`/`DATABASE_URL` is not configured.

## Commit

- `eb03cd09c226656dd312db08e3b5b3331b00907e` — `feat(history): persist exact turn checkpoints`

## Concern

PostgreSQL integration tests, including the locked-private-story encryption
case, were typechecked but not executed because this worktree has no configured
PostgreSQL test connection. The unrelated pre-existing untracked
`docs/superpowers/plans/` directory was left untouched.

---

# Task 1 fix report — round 1

## Status

DONE_WITH_CONCERNS

## Files changed

- `src/store/history-pg.ts`
- `src/db/migrations-pg/006-turn-history.sql`
- `test/pg-history.test.ts`

## Corrections

- Scoped private-checkpoint envelope snapshots and restoration to mutable
  projection tables plus the story session, preserving immutable `turns`
  envelopes. The regression verifies a later retained private turn remains
  readable after restoring an earlier checkpoint.
- Added explicit history-table `SELECT`, `INSERT`, `UPDATE`, and `DELETE`
  grants for existing `fabulist_play` and `fabulist_ingest` deployments during
  migration 006, with a migration-source assertion.
- Added a story-scoped PostgreSQL transaction advisory lock before allocating
  a history position. The concurrency regression invokes capture from separate
  transaction clients and requires positions 1 and 2.

## Validation

- `rtk pnpm typecheck` — PASS.
- `rtk pnpm exec biome check src/store/history-pg.ts test/pg-history.test.ts` — PASS.
- `rtk pnpm exec node --disable-warning=ExperimentalWarning --test test/pg-history.test.ts` — PASS; migration assertion passed, PostgreSQL integration tests skipped because no connection is configured.
- `rtk pnpm test --test-name-pattern='history checkpoint|legacy turn'` — PASS; PostgreSQL integration cases skipped because no connection is configured.
- `rtk git diff --check` — PASS.

## Commit

- `ce3358bd81578b1c63919839683f810c094c288c` — `fix(history): preserve private turn envelopes`

## Remaining concerns

The new private-envelope and concurrent-capture regressions require
`FABULIST_TEST_PG` or `DATABASE_URL` to execute against a PostgreSQL server;
this worktree has neither configured.
