/**
 * Runs the test suite as a few long-lived `node --test` processes in parallel,
 * instead of one process per test file.
 *
 *     node test/run.ts                      # every test/**\/*.test.ts
 *     node test/run.ts test/pg-*.test.ts    # just these
 *     node test/run.ts --shard=2/6 test/*.test.ts   # one CI shard
 *     node test/run.ts --record             # refresh test/timings.json
 *
 * ## Why
 *
 * `node --test` gives every file its own process, and every one of those
 * processes loaded the application's module graph again — `src/server/api.ts`
 * alone is ~0.35 s of start-up, and most files import it. Across ~110 files
 * that was ~35 s of CPU in a full run, a third of all the CPU the run used, and
 * on a 4-vCPU runner CPU is what the run is bound by. Running each group of
 * files with `--test-isolation=none` loads the graph once per group instead.
 *
 * What that gives up is a fresh process per file. Every file was checked to
 * pass in a single process with all the others, and the groups are fixed by
 * `test/timings.json` rather than chosen at random, so a run is reproducible:
 * the same files share a process every time until the timings are refreshed.
 * `node --test <file>` still runs one file on its own, as before.
 *
 * ## Balancing
 *
 * Files are dealt out longest-first to whichever group (or shard) has the least
 * work so far, using the per-file test time in `test/timings.json`. A file with
 * no recorded time counts as the median, so a new file is never a problem —
 * only a reason to `--record` again eventually. Shards are balanced the same
 * way, so no CI runner is left holding all the expensive Postgres files.
 */
import { spawn } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const timingsPath = join(import.meta.dirname, 'timings.json');

interface Options {
  shard: { index: number; total: number } | null;
  jobs: number;
  record: boolean;
  files: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { shard: null, jobs: availableParallelism(), record: false, files: [] };
  for (const arg of argv) {
    const [flag, value] = arg.split('=', 2) as [string, string | undefined];
    if (flag === '--shard' && value) {
      const [index, total] = value.split('/').map(Number);
      if (!Number.isInteger(index) || !Number.isInteger(total) || index! < 0 || index! >= total!) {
        throw new Error(`--shard wants index/total with 0 <= index < total, got ${value}`);
      }
      opts.shard = { index: index!, total: total! };
    } else if (flag === '--jobs' && value) {
      opts.jobs = Math.max(1, Number(value));
    } else if (flag === '--record') {
      opts.record = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      opts.files.push(arg);
    }
  }
  if (!opts.files.length) opts.files = globSync('test/**/*.test.ts', { cwd: root });
  opts.files = [...new Set(opts.files.map((f) => relative(root, join(root, f))))].sort();
  return opts;
}

function readTimings(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(timingsPath, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Longest first, each to the least-loaded bin. Deterministic: ties go by name, then by bin index. */
function balance(files: string[], weight: (file: string) => number, bins: number): string[][] {
  const out = Array.from({ length: bins }, () => ({ load: 0, files: [] as string[] }));
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    const bin = out.reduce((min, b) => (b.load < min.load ? b : min));
    bin.files.push(file);
    bin.load += weight(file);
  }
  return out.map((b) => b.files.sort()).filter((g) => g.length);
}

interface GroupResult {
  code: number;
  output: string;
  seconds: number;
  timings: Record<string, number>;
}

function runGroup(files: string[], record: boolean, scratch: string, n: number): Promise<GroupResult> {
  const timingFile = join(scratch, `timings-${n}.json`);
  const args = [
    '--disable-warning=ExperimentalWarning',
    '--import',
    './test/setup.ts',
    '--test',
    '--test-isolation=none',
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    ...(record ? ['--test-reporter=./test/timing-reporter.ts', `--test-reporter-destination=${timingFile}`] : []),
    ...files,
  ];
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.stdout.isTTY ? { FORCE_COLOR: '1', ...process.env } : process.env,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      let timings: Record<string, number> = {};
      if (record) {
        try {
          timings = JSON.parse(readFileSync(timingFile, 'utf8')) as Record<string, number>;
        } catch {
          // A group that crashed records nothing; its files keep their old times.
        }
      }
      resolve({
        code: code ?? (signal ? 1 : 0),
        output: Buffer.concat(chunks).toString('utf8'),
        seconds: (performance.now() - started) / 1000,
        timings,
      });
    });
  });
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const timings = readTimings();
  const known = opts.files.map((f) => timings[f]).filter((t): t is number => t !== undefined);
  const median = known.length ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)]! : 1;
  const weight = (file: string) => timings[file] ?? median;

  let files = opts.files;
  if (opts.shard) files = balance(files, weight, opts.shard.total)[opts.shard.index] ?? [];
  const groups = balance(files, weight, Math.min(opts.jobs, files.length));
  const label = opts.shard ? `shard ${opts.shard.index}/${opts.shard.total}: ` : '';
  console.log(`${label}${files.length} files in ${groups.length} parallel processes`);
  if (!groups.length) return 0;

  const scratch = mkdtempSync(join(tmpdir(), 'fabulist-test-run-'));
  try {
    const results = await Promise.all(
      groups.map(async (group, n) => {
        const result = await runGroup(group, opts.record, scratch, n);
        // Printed whole as each group finishes, so output from parallel groups never interleaves.
        const status = result.code === 0 ? 'passed' : `FAILED (exit ${result.code})`;
        console.log(
          `\n── group ${n + 1}/${groups.length}: ${group.length} files, ${result.seconds.toFixed(1)}s, ${status}`,
        );
        console.log(`   ${group.join(' ')}\n`);
        process.stdout.write(result.output);
        return result;
      }),
    );

    if (opts.record) {
      const merged = { ...timings };
      for (const r of results) {
        for (const [file, seconds] of Object.entries(r.timings)) merged[file] = Math.round(seconds * 100) / 100;
      }
      const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(timingsPath, `${JSON.stringify(sorted, null, 2)}\n`);
      console.log(`\nrecorded ${Object.keys(sorted).length} file timings in ${relative(root, timingsPath)}`);
    }

    const failed = results.filter((r) => r.code !== 0).length;
    console.log(`\n${label}${groups.length - failed}/${groups.length} groups passed`);
    return failed ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exitCode = await main();
