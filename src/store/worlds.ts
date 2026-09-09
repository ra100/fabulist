/**
 * The worlds registry: discovering, creating and locating world *files*.
 *
 * This is the layer above `stories`. The two are deliberately different kinds
 * of thing, and conflating them is what made world switching impossible before:
 *
 *   - A **story** is rows inside one file, scoped by `story_id`. Many stories
 *     share one canon. Switching is `new World(sameDb, otherStoryId)` — no file
 *     I/O at all (see `CurrentStory`).
 *   - A **world** is the file itself: its own canon, its own graph, its own
 *     `meta`, its own images. Nothing is shared between two worlds, because
 *     there is no cross-file query in SQLite here. Switching means closing one
 *     database handle and opening another.
 *
 * Layout is one directory per world:
 *
 *     data/worlds/<slug>/world.db
 *     data/worlds/<slug>/images/
 *
 * Self-contained on purpose. `store/illustration.ts` already stores image paths
 * *relative* to an images directory specifically so a save can move as a unit;
 * a per-world directory is what finally makes that property useful — deleting,
 * backing up or zipping a world is one `rm -rf`/`cp -r` of one directory, with
 * no risk of taking another world's images with it. The flat alternative
 * (`data/<slug>.db` beside a shared `data/images`) was rejected for exactly
 * that reason: illustration filenames are content-addressed, so two worlds'
 * images would interleave in one directory with nothing marking which belonged
 * to which, and deleting a world would either orphan files forever or require
 * a join against a database that had just been deleted.
 *
 * Discovery is by scanning the directory rather than by keeping an index file.
 * There is no registry JSON to corrupt, no way for the index to disagree with
 * what is on disk, and a world copied in by hand simply appears. The cost is a
 * `readdir` plus one tiny read per world on the list route, which is nothing at
 * this scale (a handful of worlds, local disk).
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { timestamp } from './backup.ts';
import { checkpoint, openDb, row, type Db } from '../db/db.ts';
import { checkIntegrity } from './integrity.ts';
import { listStories } from './world.ts';

/** Where worlds live under a data root. */
export function worldsRoot(dataRoot = 'data'): string {
  return join(dataRoot, 'worlds');
}

export interface WorldPaths {
  slug: string;
  dir: string;
  dbPath: string;
  imagesDir: string;
}

export interface WorldSummary extends WorldPaths {
  /** From `meta.worldTitle`; blank for a world the wizard has not finished. */
  title: string;
  storyCount: number;
  entityCount: number;
  /** Most recent `lastPlayedAt` across this world's stories, for ordering. */
  lastPlayedAt: string;
  bytes: number;
}

/**
 * Filesystem-safe, human-readable directory name.
 *
 * Worlds are titled by the player ("Mass Effect", "Saint Verrow"), and that
 * title becomes a directory name, so it has to survive a filesystem. Accents
 * are folded rather than stripped so "Zaklínač" yields `zaklinac` instead of
 * `zakl-na` — the app is explicitly meant to be usable for Czech and Slovak
 * worlds, and a mangled directory name is the sort of thing that looks like
 * data loss even when it is only cosmetic.
 */
export function slugify(title: string): string {
  const folded = title
    .normalize('NFD')
    // Strip combining marks: this is what turns "í" (i + U+0301) into "i".
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    // A trailing hyphen can reappear after the length clamp cuts mid-word.
    .replace(/-+$/g, '');
  // Every fallback path leads here: a title of only punctuation, only
  // non-Latin script (Cyrillic, CJK — folding leaves nothing ASCII), or the
  // empty string. `world` plus the uniquifier below still produces a usable,
  // distinct directory, which matters more than a pretty name.
  return slug || 'world';
}

export function pathsFor(slug: string, dataRoot = 'data'): WorldPaths {
  const dir = join(worldsRoot(dataRoot), slug);
  return { slug, dir, dbPath: join(dir, 'world.db'), imagesDir: join(dir, 'images') };
}

/** `mass-effect`, then `mass-effect-2`, … — never silently reuses an existing directory. */
export function uniqueSlug(title: string, dataRoot = 'data'): string {
  const base = slugify(title);
  if (!existsSync(pathsFor(base, dataRoot).dir)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existsSync(pathsFor(candidate, dataRoot).dir)) return candidate;
  }
  throw new Error(`cannot find an unused directory name for "${title}"`);
}

/**
 * A world directory is one containing `world.db`. Anything else under
 * `data/worlds/` is ignored rather than treated as broken — a stray
 * `.DS_Store`, an editor swapfile, or a half-extracted archive should not
 * make the world list throw.
 */
export function isWorldDir(dir: string): boolean {
  return existsSync(join(dir, 'world.db'));
}

/**
 * Reads the cheap summary a world picker needs, without keeping the file open.
 *
 * Opening every world to list them is the one thing here with a real cost, and
 * it is bounded: `openDb` applies `schema.sql` (all `IF NOT EXISTS`) and the
 * additive migrations, then three small aggregate queries run. The handle is
 * always closed in a `finally` — leaking one per list call would hold a WAL
 * sidecar open for a world nobody is playing.
 */
export function readWorldSummary(slug: string, dataRoot = 'data'): WorldSummary | null {
  const paths = pathsFor(slug, dataRoot);
  if (!isWorldDir(paths.dir)) return null;

  let db: Db | null = null;
  try {
    db = openDb(paths.dbPath);
    const stories = listStories(db);
    const title =
      row<{ value: string }>(db.prepare(`SELECT value FROM meta WHERE key = 'worldTitle'`).get())?.value ?? '';
    const entityCount =
      row<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM entities`).get())?.n ?? 0;
    return {
      ...paths,
      title,
      storyCount: stories.length,
      entityCount,
      // Blank rather than a fake timestamp when there are no stories: callers
      // sort on this, and inventing `now` would float an empty world to the top.
      lastPlayedAt: stories[0]?.lastPlayedAt ?? '',
      bytes: statSync(paths.dbPath).size,
    };
  } catch {
    // A corrupt or half-written file must not take out the whole list — the
    // picker is exactly the screen you need in order to recover from one.
    return null;
  } finally {
    db?.close();
  }
}

/** Every world under the data root, most recently played first. */
export function listWorlds(dataRoot = 'data'): WorldSummary[] {
  const root = worldsRoot(dataRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      const full = join(root, name);
      return statSync(full).isDirectory() && isWorldDir(full);
    })
    .map((slug) => readWorldSummary(slug, dataRoot))
    .filter((w): w is WorldSummary => w !== null)
    .sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt) || a.slug.localeCompare(b.slug));
}

/**
 * Creates an empty world directory and its database.
 *
 * The file is opened and closed immediately: `openDb` is what applies the
 * schema, so a world created but never opened would otherwise be a directory
 * containing nothing, and `isWorldDir` would not see it. Creating it eagerly
 * also means the failure mode for an unwritable data root happens here, at the
 * click of "new world", rather than later during ingest.
 */
export function createWorldFile(title: string, dataRoot = 'data'): WorldSummary {
  const slug = uniqueSlug(title, dataRoot);
  const paths = pathsFor(slug, dataRoot);
  mkdirSync(paths.dir, { recursive: true });
  const db = openDb(paths.dbPath);
  try {
    if (title.trim()) {
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('worldTitle', ?)`).run(title.trim());
    }
  } finally {
    db.close();
  }
  return readWorldSummary(slug, dataRoot)!;
}

/**
 * Deletes a world directory outright — database, sidecars and images.
 *
 * The whole directory rather than the files we know about: a WAL-mode database
 * is three files, and unlinking only `world.db` leaves a `-wal` that a later
 * world reusing the slug could be opened against. Since the directory holds
 * nothing but this world by construction, removing it is both complete and safe.
 *
 * Refuses the currently-open world; the caller passes `openSlug` so that
 * decision lives in one place rather than being re-derived by every route.
 */
export function deleteWorldFile(slug: string, opts: { dataRoot?: string; openSlug?: string } = {}): void {
  const dataRoot = opts.dataRoot ?? 'data';
  const paths = pathsFor(slug, dataRoot);
  if (!isWorldDir(paths.dir)) throw new Error(`no world "${slug}"`);
  if (opts.openSlug === slug) {
    throw new Error('cannot delete the world that is currently open; switch to another world first');
  }
  rmSync(paths.dir, { recursive: true, force: true });
}

/**
 * Replaces a world's `world.db` with an uploaded file — the server-side half
 * of `POST /api/worlds/:slug/upload`, for the case this was actually written
 * for: a save repaired on another machine (e.g. `sqlite3 .recover` after
 * corruption) and handed back over HTTP instead of `scp`, so a deployed
 * instance with no SSH access for the operator can still recover a save.
 *
 * Same refusal as `deleteWorldFile` and for the identical reason: swapping the
 * file out from under a live `Db` handle is the exact hazard the README's
 * "Copying a save" section documents (WAL mode splits an open database across
 * `.db`/`-wal`/`-shm`; the caller would be replacing one third of a live
 * database while the other two sidecars still point at the old one). The
 * caller switches away first — this never force-closes anything itself.
 *
 * Validated *before* anything on disk changes, in this order:
 *
 *   1. `PRAGMA integrity_check` on the upload, written to a throwaway temp
 *      path first — this is the exact check that caught the "database disk
 *      image is malformed" failure this endpoint exists to fix, so letting an
 *      upload past this and *then* discovering it is broken would recreate
 *      the original problem one layer up.
 *   2. This repo's own `checkIntegrity` — cheap once the file already opened
 *      cleanly, and catches dangling entity references `PRAGMA
 *      integrity_check` cannot see (see `store/integrity.ts`).
 *
 * The existing file is backed up (via `world.db.pre-upload-<stamp>`,
 * alongside the sidecars if any survived an earlier crash) rather than
 * deleted outright — an upload that turns out to be the wrong file, or a
 * second corrupt copy, must not destroy the last known-good copy on its way
 * in.
 */
export function replaceWorldFile(
  slug: string,
  bytes: Buffer,
  opts: { dataRoot?: string; openSlug?: string } = {},
): WorldSummary {
  const dataRoot = opts.dataRoot ?? 'data';
  const paths = pathsFor(slug, dataRoot);
  if (!isWorldDir(paths.dir)) throw new Error(`no world "${slug}"`);
  if (opts.openSlug === slug) {
    throw new Error('cannot replace the world that is currently open; switch to another world first');
  }
  if (!bytes.length) throw new Error('uploaded file is empty');

  // A path next to the real one, not `os.tmpdir()`: the eventual `renameSync`
  // below must stay on one filesystem to be atomic, and a container's `/tmp`
  // is not guaranteed to share a mount with the bind-mounted data volume.
  const stamp = timestamp();
  const candidatePath = `${paths.dbPath}.upload-${stamp}`;
  writeFileSync(candidatePath, bytes);

  let db: Db;
  try {
    db = openDb(candidatePath);
  } catch (err) {
    unlinkSync(candidatePath);
    throw new Error(`uploaded file is not a valid SQLite database: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const check = row<{ integrity_check: string }>(db.prepare('PRAGMA integrity_check').get());
    if (check?.integrity_check !== 'ok') {
      throw new Error(`uploaded database failed PRAGMA integrity_check: ${check?.integrity_check ?? 'unknown error'}`);
    }
    const report = checkIntegrity(db);
    if (!report.ok) {
      throw new Error(`uploaded database has ${report.orphans.length} dangling reference(s); run pnpm integrity on it locally for details`);
    }
  } finally {
    db.close();
  }

  const backupPath = `${paths.dbPath}.pre-upload-${stamp}`;
  if (existsSync(paths.dbPath)) renameSync(paths.dbPath, backupPath);
  // Stale sidecars from whatever was open before must not survive next to the
  // new file — an old `-wal` would be replayed against pages that no longer
  // mean what it thinks they mean.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${paths.dbPath}${suffix}`;
    if (existsSync(sidecar)) renameSync(sidecar, `${backupPath}${suffix}`);
  }
  // Same-filesystem rename, atomic: the world directory never observes a
  // half-written `world.db`.
  renameSync(candidatePath, paths.dbPath);

  return readWorldSummary(slug, dataRoot)!;
}

/**
 * Renames a world's *title*, and its directory when the derived slug changes.
 *
 * The directory is only renamed when the world is not open: moving a file out
 * from under a live SQLite handle is exactly the sort of thing that appears to
 * work on macOS (the inode survives) and then loses writes in ways that surface
 * much later. When the world is open, the title changes and the slug is left
 * alone — cosmetically inconsistent, but never destructive, and the next
 * process to open it can be told to tidy up.
 */
export function renameWorldFile(
  slug: string,
  title: string,
  opts: { dataRoot?: string; openSlug?: string } = {},
): WorldSummary {
  const dataRoot = opts.dataRoot ?? 'data';
  const paths = pathsFor(slug, dataRoot);
  if (!isWorldDir(paths.dir)) throw new Error(`no world "${slug}"`);

  const db = openDb(paths.dbPath);
  try {
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('worldTitle', ?)`).run(title.trim());
  } finally {
    db.close();
  }

  const desired = slugify(title);
  const canMove = opts.openSlug !== slug && desired !== slug && !existsSync(pathsFor(desired, dataRoot).dir);
  if (canMove) {
    renameSync(paths.dir, pathsFor(desired, dataRoot).dir);
    return readWorldSummary(desired, dataRoot)!;
  }
  return readWorldSummary(slug, dataRoot)!;
}

/**
 * Moves a pre-multi-world save into the new layout, returning its slug.
 *
 * Before this module a world was one path from config (`data/fabulist.db`) with
 * images beside it. Those saves are somebody's actual novel, so the migration
 * *moves* the existing files into `data/worlds/<slug>/` rather than asking the
 * player to start over or leaving them stranded at a path nothing reads
 * anymore.
 *
 * `renameSync` rather than copy-then-delete: it is atomic within a filesystem,
 * so an interrupted migration leaves the save either fully at the old path or
 * fully at the new one, never duplicated at both with no way to tell which is
 * authoritative. The sidecars move too when present — a `-wal` left behind
 * would be silently dropped, which is the precise failure `store/backup.ts`
 * exists to document.
 *
 * Returns null when there is nothing to migrate, so callers can treat "already
 * migrated" and "fresh install" identically.
 */
export function migrateLegacySave(legacyDbPath: string, dataRoot = 'data'): WorldSummary | null {
  if (!existsSync(legacyDbPath)) return null;

  // Read the title first so the slug is meaningful rather than `world`, and
  // checkpoint while we have it open: folding the sidecar back into the main
  // file *before* the move is what makes moving a single `.db` complete. The
  // `-wal` handling below is the fallback for a file we could not open at all.
  let title = '';
  try {
    const db = openDb(legacyDbPath);
    try {
      title = row<{ value: string }>(db.prepare(`SELECT value FROM meta WHERE key = 'worldTitle'`).get())?.value ?? '';
      checkpoint(db);
    } finally {
      db.close();
    }
  } catch {
    // Unreadable: still worth moving, under a generic name, rather than
    // leaving it somewhere nothing will ever look at again.
  }

  const slug = uniqueSlug(title || 'imported world', dataRoot);
  const paths = pathsFor(slug, dataRoot);
  mkdirSync(paths.dir, { recursive: true });

  renameSync(legacyDbPath, paths.dbPath);
  // Only reachable when the file could not be opened above (so no checkpoint
  // happened) or when SQLite left a sidecar behind anyway. Moving them is
  // harmless when they are already folded in, and prevents silently dropping
  // committed rows when they are not — the precise failure `store/backup.ts`
  // exists to document.
  for (const suffix of ['-wal', '-shm']) {
    const side = `${legacyDbPath}${suffix}`;
    if (existsSync(side)) renameSync(side, `${paths.dbPath}${suffix}`);
  }

  // Legacy images lived in `<dir>/images`, shared by the single world. Move the
  // directory wholesale when it is not already where we want it.
  const legacyImages = join(resolve(legacyDbPath, '..'), 'images');
  if (existsSync(legacyImages) && resolve(legacyImages) !== resolve(paths.imagesDir)) {
    renameSync(legacyImages, paths.imagesDir);
  }

  return readWorldSummary(slug, dataRoot);
}
