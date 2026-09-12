# Task 3 — Exact retained-turn rollback and forks

## Implemented

- Extended SQLite and PostgreSQL rollback options with `turnId`, enforcing one
  and only one target alongside each store's existing scene/chapter fields.
- Added exported `rollbackToTurn` adapters. Destructive rollback invokes the
  history store's transactional `restoreTurn`; safe rollback forks at the
  retained turn.
- Added clear, distinct validation for unknown turns, legacy turns with no
  exact history, and turns whose immutable history position lacks its
  checkpoint.
- Added `HistoryStore.restoreTurn` in both backends. It restores the selected
  checkpoint, retains the selected turn, removes later positioned turns,
  checkpoints, and scene-segment boundaries, and leaves all other stories and
  canon outside the transaction scope. PostgreSQL takes the existing
  story-scoped advisory lock and removes encrypted payloads for pruned
  checkpoints before deleting those records.
- Added `checkpointsThrough` in both history stores and exact-turn fork
  support in both branch stores. Forks materialize the selected checkpoint
  projection rather than a scene-wide range, regenerate colliding IDs, remap
  internal references, copy only retained checkpoints and segment boundaries,
  remap segment IDs, and restore the retained session cursor. The source story
  is read-only throughout.
- Exact PostgreSQL forks reject an unprepared private story instead of risking
  a plaintext downgrade or copying ciphertext that is bound to the source
  story identity.

## Tests

- Added SQLite behavior coverage for selected-turn retention and exact state,
  safe fork isolation/retained checkpoint history, mutual target exclusion,
  and unknown, legacy, and missing-checkpoint failures.
- Added equivalent PostgreSQL behavior coverage. The local environment has no
  PostgreSQL configuration, so those tests were discovered but skipped.

## Validation

- `rtk pnpm typecheck` — passed.
- `rtk node --disable-warning=ExperimentalWarning --test
  --test-name-pattern='turn rollback|rollback defaults|fork.*history'
  test/branch.test.ts test/pg-history.test.ts` — 4 passed; 2 PostgreSQL tests
  skipped because PostgreSQL is not configured.
- `rtk git diff --check` — passed.
