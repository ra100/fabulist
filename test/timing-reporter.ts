/**
 * A `node --test` reporter that records how long each test file's tests took,
 * for `test/run.ts --record`. Writes one JSON object, `{ [file]: seconds }`,
 * summing the top-level tests of each file.
 *
 * Top-level tests rather than wall time per file because `test/run.ts` runs
 * many files in one process: module loading is shared there, so the part that
 * differs from file to file — and so the part worth balancing — is the tests.
 */
import { relative } from 'node:path';

interface TestEvent {
  type: string;
  data: { nesting?: number; file?: string; details?: { duration_ms?: number } };
}

export default async function* timingReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const seconds: Record<string, number> = {};
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { nesting, file, details } = event.data;
    if (nesting !== 0 || !file || details?.duration_ms === undefined) continue;
    const key = relative(process.cwd(), file);
    seconds[key] = (seconds[key] ?? 0) + details.duration_ms / 1000;
  }
  yield JSON.stringify(seconds);
}
