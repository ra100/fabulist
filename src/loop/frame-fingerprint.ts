import { createHash } from 'node:crypto';

/** Hashes JSON-like frame inputs without depending on object or Map insertion order. */
export function fingerprintFrameInput(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalFrameInput(value)))
    .digest('hex');
}

function canonicalFrameInput(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [canonicalFrameInput(key), canonicalFrameInput(item)])
      .sort(([left], [right]) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (Array.isArray(value)) return value.map(canonicalFrameInput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalFrameInput(item)]),
    );
  }
  return value;
}
