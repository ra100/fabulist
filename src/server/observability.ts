import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderCallTelemetry } from '../loop/provider-telemetry.ts';

type LogValue = string | number | boolean | null;
type LogFields = Record<string, LogValue | undefined>;

function write(level: 'info' | 'error', event: string, fields: LogFields = {}): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function logEvent(event: string, fields: LogFields = {}): void {
  write('info', event, fields);
}

export function logError(event: string, fields: LogFields = {}): void {
  write('error', event, fields);
}

export function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
}

/**
 * Start one request log without recording query strings, headers, bodies, users,
 * story identifiers, or client addresses. Dynamic route segments are reported
 * by the dispatch loop using its parameterised route pattern.
 */
export function startHttpRequest(req: IncomingMessage, res: ServerResponse, path: string): string {
  const requestId = randomUUID();
  const started = Date.now();
  let finished = false;
  res.setHeader('x-request-id', requestId);
  logEvent('http.request.start', { requestId, method: req.method ?? 'UNKNOWN', path });
  res.once('finish', () => {
    finished = true;
    logEvent('http.request.complete', {
      requestId,
      method: req.method ?? 'UNKNOWN',
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });
  res.once('close', () => {
    if (finished) return;
    logError('http.request.closed', {
      requestId,
      method: req.method ?? 'UNKNOWN',
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });
  return requestId;
}

export function logProviderCall(requestId: string, call: ProviderCallTelemetry): void {
  logEvent('ai.call', {
    requestId,
    role: call.role,
    provider: call.provider,
    model: call.model,
    tokensIn: call.tokensIn,
    tokensOut: call.tokensOut,
    responseChars: call.responseChars,
    streamChars: call.streamChars,
    attempt: call.attempt,
    maxTokens: call.maxTokens,
    streaming: call.streaming,
    finishReason: call.finishReason,
    durationMs: call.durationMs,
    ok: call.ok,
    errorKind: call.errorKind,
    errorStatus: call.errorStatus,
    errorDetail: call.errorDetail,
  });
}
