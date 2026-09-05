/**
 * Safe copies of a save. See `.design/DBFIXES.md` A3.
 *
 * The reason this exists rather than a documented `cp`: a WAL-mode database is
 * three files while open (`.db`, `-wal`, `-shm`), and the main file alone can be
 * arbitrarily stale. Copying it by hand silently loses whatever is still in the
 * sidecar — not a hypothetical, and not a small amount: a real save in this
 * project reported *clean* through a `cp`-made copy while 4.1 MB of committed
 * rows, including the three orphaned illustrations that exposed a `reset()` bug,
 * sat in the `-wal` the copy did not include.
 *
 * `VACUUM INTO` rather than checkpoint-then-copy, for three reasons: it is
 * transactional (a reader sees either no file or a complete one, never a torn
 * one), it emits a single defragmented file with no sidecars, and it cannot
 * observe a half-written page the way a filesystem copy racing a writer can.
 * Checkpointing first is still worth doing so the source file itself stops
 * carrying a large sidecar around.
 *
 * Images are copied separately because they deliberately live outside the
 * database (`store/illustration.ts`): the rows carry relative paths so a save
 * directory can move as a unit, which also means a database-only backup restores
 * to rows pointing at files that are not there.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkpoint, openDb, type Db } from '../db/db.ts';

export interface BackupResult {
  dbPath: string;
  /** Where the images went, or null when the source had none. */
  imagesPath: string | null;
  bytes: number;
  imageCount: number;
}

/** Where `serve.ts` and friends keep images for a given database path. */
export function imagesDirFor(dbPath: string): string {
  return join(dirname(dbPath), 'images');
}

/**
 * Copies an already-open database. Separated from `backupSave` so a caller
 * holding a live `World` (a server about to do something destructive, say) can
 * snapshot without reopening the file underneath itself.
 */
export function vacuumInto(db: Db, toPath: string): number {
  if (existsSync(toPath)) throw new Error(`${toPath} already exists`);
  mkdirSync(dirname(resolve(toPath)), { recursive: true });
  // Fold the sidecar in first: this leaves the *source* tidy as well, and means
  // the vacuum has less to walk.
  checkpoint(db);
  // No parameter binding: VACUUM INTO takes a literal, and this is a path the
  // operator supplied on their own command line rather than untrusted input.
  // Single quotes are doubled so a path containing one cannot terminate the
  // string early.
  db.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
  return statSync(toPath).size;
}

/**
 * Copies a save's database and its images to a destination prefix.
 *
 * `toPrefix` is a path without an extension: `data/backups/before-ingest`
 * becomes `before-ingest.db` plus a `before-ingest-images/` directory. One
 * prefix rather than two arguments because the two halves must not drift apart
 * — a database whose images went somewhere else is a restore that half works.
 */
export function backupSave(fromDbPath: string, toPrefix: string): BackupResult {
  if (!existsSync(fromDbPath)) throw new Error(`no save at ${fromDbPath}`);

  const dbOut = `${toPrefix}.db`;
  const db = openDb(fromDbPath);
  let bytes: number;
  try {
    bytes = vacuumInto(db, dbOut);
  } finally {
    db.close();
  }

  const imagesIn = imagesDirFor(fromDbPath);
  let imagesPath: string | null = null;
  let imageCount = 0;
  if (existsSync(imagesIn)) {
    const entries = readdirSync(imagesIn).filter((f) => statSync(join(imagesIn, f)).isFile());
    if (entries.length) {
      imagesPath = `${toPrefix}-images`;
      mkdirSync(imagesPath, { recursive: true });
      for (const f of entries) copyFileSync(join(imagesIn, f), join(imagesPath, f));
      imageCount = entries.length;
    }
  }

  return { dbPath: dbOut, imagesPath, bytes, imageCount };
}

/** A sortable, filename-safe stamp: `20260905-230017`. */
export function timestamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}
