# Turn rollback and scene splitting design

## Goal

Let an author:

1. Roll a story back to a specific committed turn while preserving that selected
   turn.
2. Split an existing scene at a selected committed turn, making that turn the
   start of a new real scene.
3. Keep the existing chapter and scene rollback choices and the safe
   fork-by-default behavior.

The feature must undo prose and every later state change together. It must not
pretend that old saves can provide exact per-turn restoration when they do not
contain the required history.

## Scope and terminology

A **turn** is the committed unit of player input and generated prose. It is the
new finest rollback target. In the UI, turns are shown as a stable
chapter-turn position, for example `1-2` for turn 2 in chapter 1.

A **scene split** is a boundary placed before a selected turn. It is not merely
a visual divider: the chosen turn begins a new scene, later play writes into
that scene, and compaction, timeline, frames, and exports use the revised
scene structure.

Chapter rollback and scene rollback retain their current semantics: they
discard the target boundary and everything after it. Turn rollback deliberately
differs: it retains the selected turn and discards only later history.

## Immutable history

New story writes will carry a monotonic history position. A history position
orders committed turns and manual state mutations independently of their
displayed scene and turn numbers.

After every committed turn and every authoring mutation, Fabulist writes an
immutable checkpoint of the story-scoped mutable state. The checkpoint contains
the chronicle projection needed to resume play, including cast state,
chronicle graph rows, relations, facts and knowledge, threads, consequences,
directives, anchors, scenes, chapters, and the session cursor. Checkpoint
payloads are stored with the story's existing encryption guarantees; no
private prose or state is introduced as plaintext snapshot data.

A turn rollback selects the checkpoint recorded directly after the target
turn. In a single transaction it restores that checkpoint and removes later
turn records, checkpoints, split markers, and derived summaries. This makes
the selected turn the final preserved record and restores the exact state the
engine saw after committing it.

The snapshot-and-position design is preferred over replaying deltas because
not every authoring mutation is representable as a turn delta, and replaying
old mutable rows would either lose edits or guess at their order.

## Legacy histories

Pre-feature history has scene-level provenance only. It lacks the per-turn
state snapshots necessary to restore an arbitrary earlier turn safely.

Those turns remain readable and continue to support existing scene- and
chapter-level rollback. They may receive visual labels, but cannot be used as
turn rollback or true scene-split targets. The API and UI report that exact
history starts with the first eligible post-upgrade turn rather than
best-effort reconstructing state.

## Scene splitting

`split_scene` accepts a committed eligible turn and places a durable scene
boundary immediately before it. The operation:

1. Validates that the selected turn exists, has exact history, and is not
   already the first turn of a scene.
2. Creates the boundary and recalculates display scene membership for that
   turn and all following turns.
3. Rebuilds the affected scene and chapter summaries from their new turn
   ranges.
4. Moves the active session cursor and future writes into the resulting
   current scene when the split changes the active timeline.

The history position remains immutable. Scene and chapter identifiers are
derived presentation and compaction groupings, so inserting a past boundary
does not corrupt causal ordering or invalidate existing checkpoints.

The operation is transactional in both SQLite and PostgreSQL. If validation,
summary rebuild, or persistence fails, no boundary or partial reindexing is
visible.

## Interfaces

### HTTP and MCP

Extend `rollback` targets so that exactly one of `chapter`, `scene`, or
`turn` is accepted. The turn target identifies a committed turn and returns
the preserved position alongside the current fork/destructive result shape.

Add `split_scene` with a turn target. Both APIs validate strict request shapes,
ownership, private-story readiness for forks, and exact-history eligibility.
The MCP server exposes matching tools and descriptions in both SQLite and
PostgreSQL modes.

The CLI gains matching turn rollback and scene-split commands so browser, MCP,
and terminal authors have consistent capabilities.

### Browser

The Book and Timeline show committed turn positions. Eligible turns expose
"split scene here." The rollback panel lets an author choose chapter, scene,
or turn and continues to present two explicit outcomes:

- **Fork (safe):** create and switch to a sibling story ending at the selected
  turn; the original remains unchanged.
- **Discard permanently:** restore the selected turn checkpoint in place after
  an explicit confirmation.

Controls explain why legacy or otherwise ineligible turns cannot be selected.
Errors remain in the existing visible notices; no operation silently falls
back to a scene-level rollback.

## Storage and execution boundaries

Add storage for history positions, checkpoints, and scene-split boundaries to
both database implementations. Keep persistence APIs behind corresponding
chronicle/history store methods rather than duplicating database logic in API
handlers.

The rollback service owns target resolution and checkpoint restoration. The
scene-splitting service owns boundary validation, grouping recalculation, and
summary invalidation. REST, MCP, and CLI adapters call those services instead
of reimplementing their rules.

Forking copies the checkpoint and boundary history up to its retained
position. Destructive rollback removes later records. This preserves the
existing isolation rule: an operation touches only the selected story, never
shared canon or another story.

## Errors

Return explicit errors for:

- zero, multiple, or malformed rollback targets;
- a missing, uncommitted, legacy, or ineligible target turn;
- a split at a turn already starting a scene;
- a rollback target with no matching checkpoint;
- attempts to fork a private story without the required readiness;
- database failures while recording/restoring a checkpoint or split.

The server maps expected validation failures to `400`, ownership failures to
their existing authorization response, and unexpected persistence failures to
the established server error path. No endpoint will substitute a nearest scene
boundary when turn restoration is unavailable.

## Testing

Test the shared behavioral contract in SQLite and PostgreSQL:

- a turn rollback preserves the selected turn and restores its exact state;
- later prose, graph/cast/fact/knowledge/thread/consequence/directive changes
  are absent after rollback;
- safe forks leave the source untouched and copy only retained history;
- destructive rollback creates no sibling;
- a historical scene split re-groups the selected and later turns, invalidates
  summaries, and makes future turns use the new scene;
- legacy targets are rejected without modifying the story;
- invalid targets, duplicate boundaries, ownership checks, and transaction
  failures leave state unchanged.

Add HTTP and MCP contract tests for the new strict input shapes and outcomes.
Typecheck and build the browser after exercising the Book/Timeline controls.

## Out of scope

- Best-effort reconstruction of pre-feature turns.
- Automatic scene splitting.
- Editing or rolling back shared canon.
- Changes to the current chapter-size policy beyond recomputing groupings
  affected by a manual split.
