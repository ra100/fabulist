/**
 * Shared plumbing for the SDK-backed adapters: error mapping and prose
 * streaming.
 *
 * Both live here rather than in `openai-sdk.ts` for the same reason. The
 * streaming half encodes three things that are easy to get wrong and were all
 * found by the parity contract — the `onError` capture in particular is the
 * difference between a rejected key and a silent blank scene — and copying that
 * into four more adapters would mean five chances to get it wrong.
 */
import { APICallError, NoOutputGeneratedError, streamText } from 'ai';
import {
  ProviderHttpError,
  normalizeFinishReason,
  scrubSecrets,
  type CompletionResult,
} from './provider.ts';

/**
 * Rebuilds an SDK transport error as the error the rest of Fabulist understands.
 *
 * `APICallError` is unsafe to surface as-is: its `responseBody` is unbounded and
 * its `requestBodyValues` holds the entire prompt. `byok.ts` decides "your key
 * was rejected" from `status` and reads `body` for a provider-specific reason,
 * so an adapter that threw the raw error would lose both the copy and the
 * scrub. Anything that is not an `APICallError` passes through untouched.
 */
export function asProviderError(err: unknown, secret: string): unknown {
  if (!(err instanceof APICallError)) return err;
  const body = scrubSecrets((err.responseBody ?? '').slice(0, 300), [secret]);
  const status = err.statusCode ?? 502;
  return new ProviderHttpError(status, `${err.url ?? 'provider'} returned ${status}: ${body}`, body);
}

/**
 * What `streamText` accepts. The two handlers are optional there and are
 * overridden below, so the callers pass a plain request.
 */
/**
 * Reads a structured result, yielding `undefined` instead of throwing when the
 * model answered with something that is not the requested shape.
 *
 * `result.output` is a getter that throws `NoOutputGeneratedError` on access, so
 * `Promise.resolve(result.output).catch(...)` does not catch it — the throw
 * happens while evaluating the argument. Fabulist's own validator decides
 * whether a bad shape is worth repairing, so this must not become a failed turn.
 */
export async function readStructuredOutput(result: { readonly output: unknown }): Promise<unknown> {
  try {
    return await Promise.resolve(result.output);
  } catch {
    return undefined;
  }
}

type StreamRequest = Parameters<typeof streamText>[0];

/**
 * Streams prose, emitting each delta as it arrives.
 *
 * `emit` is called from the SDK's own `onChunk`, so a writer sees the paragraph
 * grow. Buffering the deltas and replaying them after the stream resolved would
 * satisfy an ordering assertion while destroying the thing streaming is for.
 */
export async function streamProse(
  request: StreamRequest,
  model: string,
  readSecret: () => Promise<string>,
  emit: (chunk: string) => void,
): Promise<CompletionResult> {
  const chunks: string[] = [];
  let failure: unknown;

  const result = streamText({
    ...request,
    onChunk: ({ chunk }) => {
      if (chunk.type !== 'text-delta') return;
      chunks.push(chunk.text);
      emit(chunk.text);
    },
    // Without this the SDK replaces a 401 with "no output generated", which
    // drops the status `byok.ts` needs to tell a rejected key from an outage —
    // a rate limit would surface to the user as a blank scene.
    onError: ({ error }) => {
      failure ??= error;
    },
  });

  try {
    await result.text;
  } catch (err) {
    // An empty stream is not an incident: the hand-rolled adapters returned
    // empty prose and callers treat a quiet turn as normal. Anything else is a
    // real parse or transport failure and must not pass silently.
    if (failure === undefined && !(err instanceof NoOutputGeneratedError)) {
      throw asProviderError(err, await readSecret());
    }
  }
  if (failure !== undefined) throw asProviderError(failure, await readSecret());

  // Read from the accumulated deltas rather than `result.text`, so a stream
  // that died part-way still yields the prose the writer already saw.
  // Both are PromiseLike rather than Promise, hence the explicit wrap.
  const usage = await Promise.resolve(result.usage).catch(() => undefined);
  return {
    text: chunks.join(''),
    tokensIn: usage?.inputTokens ?? 0,
    tokensOut: usage?.outputTokens ?? 0,
    model,
    schemaEnforced: false,
    finishReason: normalizeFinishReason(await Promise.resolve(result.finishReason).catch(() => undefined)),
  };
}
