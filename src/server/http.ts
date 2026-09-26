import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { output, ZodTypeAny } from 'zod';
import { RollbackTargetError, SceneSplitTargetError, WorldAccessError } from '../domain/types.ts';
import { PrivateStoryLockedError } from '../store/private-story-access.ts';
import { ProviderKeyLockedError } from '../providers/byok.ts';

const DEFAULT_JSON_LIMIT = 1024 * 1024;
const DEFAULT_RAW_LIMIT = 256 * 1024 * 1024;

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `request body exceeds ${limit} bytes`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export async function readJsonBody(req: IncomingMessage, limit = DEFAULT_JSON_LIMIT): Promise<unknown> {
  const bytes = await readBytes(req, limit);
  if (!bytes.length) return undefined;

  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    throw new HttpError(415, 'content-type must be application/json');
  }

  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

export function readRawBody(req: IncomingMessage, limit = DEFAULT_RAW_LIMIT): Promise<Buffer> {
  return readBytes(req, limit);
}

/**
 * The JSON body for a request that failed with `status`.
 *
 * A 4xx message is the caller's to read. A 5xx one is whatever an internal layer
 * threw — SQL, file paths, a provider's response — so a server that `hides`
 * internals (any signed-in, multi-user one) logs it under a short reference and
 * answers with only that.
 */
export function errorBody(err: unknown, status: number, hide: boolean): { error: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (status < 500 || !hide) return { error: message };
  const ref = randomUUID().slice(0, 8);
  console.error(`internal error ref ${ref}:`, err);
  return { error: `internal error (ref ${ref})` };
}

export function statusForError(err: unknown): number {
  if (err instanceof HttpError || err instanceof WorldAccessError) return err.status;
  if (err instanceof ProviderKeyLockedError) return 423;
  // The caller's own state, not a server fault: the story's key is not unlocked in
  // this session. A 4xx keeps the message, which the UI matches to offer an unlock.
  if (err instanceof PrivateStoryLockedError) return 423;
  return err instanceof SceneSplitTargetError || err instanceof RollbackTargetError ? 400 : 500;
}

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): output<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, `${path}${issue?.message ?? 'invalid request body'}`);
}
