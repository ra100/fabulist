/**
 * Portable, release-ready SQLite worlds.
 *
 * A pack deliberately remains a plain directory: extracting it directly into
 * `data/worlds/` makes it discoverable without an import step. The database is
 * produced through `backupSave`, never copied from a potentially live WAL.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { openDb, row } from '../db/db.ts';
import { backupSave } from './backup.ts';
import { checkIntegrity } from './integrity.ts';

export interface ReleasePackManifest {
  format: 'fabulist-world-pack';
  formatVersion: 1;
  fabulistVersion: string;
  createdAt: string;
  world: {
    title: string;
    entityCount: number;
    storyCount: number;
    ingestContext: unknown | null;
  };
}

export interface ReleasePackResult {
  dir: string;
  dbPath: string;
  manifest: ReleasePackManifest;
  imageCount: number;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

function parseJson(value: string): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Builds a directory that can be extracted unchanged under `data/worlds/`.
 * The target must not already exist: a release build is a snapshot, never an
 * in-place update that could erase a prior artifact.
 */
export function createReleasePack(sourceDbPath: string, targetDir: string, fabulistVersion: string): ReleasePackResult {
  if (existsSync(targetDir)) throw new Error(`release pack destination already exists: ${targetDir}`);
  mkdirSync(dirname(targetDir), { recursive: true });
  mkdirSync(targetDir);

  try {
    const backup = backupSave(sourceDbPath, join(targetDir, 'world'));
    if (backup.imagesPath) renameSync(backup.imagesPath, join(targetDir, 'images'));

    const db = openDb(backup.dbPath);
    let manifest: ReleasePackManifest;
    try {
      const integrity = checkIntegrity(db);
      if (!integrity.ok) throw new Error('world integrity check failed; release pack was not created');
      const valueFor = (key: string) =>
        row<{ value: string }>(db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key))?.value ?? '';
      const entityCount = row<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM entities`).get())?.n ?? 0;
      const storyCount = row<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM stories`).get())?.n ?? 0;
      manifest = {
        format: 'fabulist-world-pack',
        formatVersion: 1,
        fabulistVersion,
        createdAt: new Date().toISOString(),
        world: {
          title: valueFor('worldTitle'),
          entityCount,
          storyCount,
          ingestContext: parseJson(valueFor('ingestContext')),
        },
      };
    } finally {
      db.close();
    }

    const manifestPath = join(targetDir, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const sums = filesUnder(targetDir)
      .map((path) => `${sha256(path)}  ${relative(targetDir, path)}`)
      .join('\n');
    writeFileSync(join(targetDir, 'SHA256SUMS'), `${sums}\n`);
    return { dir: targetDir, dbPath: backup.dbPath, manifest, imageCount: backup.imageCount };
  } catch (err) {
    rmSync(targetDir, { recursive: true, force: true });
    throw err;
  }
}
