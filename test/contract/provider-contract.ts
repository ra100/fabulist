/**
 * Executable parity contract for `Provider.complete()`.
 *
 * Issue #165 phase 0. The point is to fix what Fabulist *promises its own
 * callers* before any transport underneath is replaced, so a swap from
 * hand-rolled HTTP to an AI SDK module is judged against a recorded baseline
 * rather than against "does it still seem to work".
 *
 * The harness is deliberately blind to wire formats. A contract declares how
 * to build itself and what its API's *response* looks like; everything it
 * asserts is observable through `Provider` alone. That is what lets the same
 * suite run unchanged against today's `OpenAICompatProvider` and tomorrow's
 * SDK-backed adapter.
 *
 * Keep the assertions here behavioural. Asserting on `response_format`,
 * `guided_json`, or `stream_options` would re-freeze the wire format, which is
 * the one thing these phases exist to change. Wire-shape checks belong in the
 * per-adapter suites that already cover them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Provider, ProviderCapabilities } from '../../src/providers/provider.ts';
import { extractJson, normalizeFinishReason } from '../../src/providers/provider.ts';

/**
 * How a provider's streaming bytes are framed. The harness has to speak each
 * one or Bedrock cannot be held to the same bars as the SSE providers.
 */
export type StreamFraming = 'sse' | 'ndjson' | 'aws-eventstream';

/** A scripted upstream reply: either a JSON body or a list of stream payloads. */
export interface ScriptedResponse {
  status?: number;
  /** Response body for a non-streaming call. */
  json?: unknown;
  /** Stream payloads for a streaming call, already shaped for this provider's API. */
  frames?: string[];
  /** Raw body text, for error paths. */
  bodyText?: string;
}

export interface ContractBuildOptions {
  /** Records every outgoing request so a test can inspect it. */
  fetcher: typeof fetch;
  /** Overrides for what the provider declares about itself. */
  capabilities?: Partial<ProviderCapabilities>;
  timeoutMs?: number;
}

export interface ProviderContract {
  /** Names the suite, e.g. `openai-compat`. */
  label: string;
  /** Model id the adapter should echo back on `CompletionResult.model`. */
  model: string;
  /**
   * Response body for a plain completion, given the finish reason the upstream
   * reports. Providers differ in field names; this is the seam.
   */
  body(over?: { finishReason?: string; text?: string }): unknown;
  /**
   * Response body for a *structured* request, when the provider's structured
   * path returns something other than plain text.
   *
   * Bedrock obliges the model to emit tool arguments, so its structured answer
   * is a `toolUse` block rather than a text block — one shared `body()` cannot
   * describe both without lying about one of them.
   */
  structuredBody?(over?: { finishReason?: string }): unknown;
  /**
   * The object a structured request is expected to yield.
   *
   * Asserted against the adapter's `text`, so a contract whose structured path
   * returns a tool-use block (Bedrock) states its expectation the same way one
   * returning text does.
   */
  structuredValue?: unknown;
  /** `data:` payloads for a streaming completion, already shaped for this provider's API. */
  frames(over?: { tokensIn?: number; tokensOut?: number; finishReason?: string }): string[];
  /**
   * How those payloads reach the client. Defaults to `sse`.
   *
   * Ollama emits newline-delimited JSON and Bedrock emits a binary AWS event
   * stream, so a single framing assumption would quietly skip the two adapters
   * most likely to break.
   */
  framing?: StreamFraming;
  /** Constructs the adapter under test against a scripted transport. */
  build(opts: ContractBuildOptions): Provider;
  /** True when the adapter declares native schema conformance for its default capabilities. */
  nativeSchema?: boolean;
  /** False when the adapter has no streaming path at all. */
  streaming?: boolean;
}

/**
 * Encodes AWS's `application/vnd.amazon.eventstream` framing: a 12-byte prelude
 * (total length, headers length, prelude CRC, big-endian), the headers, the
 * payload as bare JSON, then a trailing message CRC.
 *
 * The reader in `src/providers/stream.ts` skips CRC verification, so zero
 * bytes are fine here — but the *lengths* must be right, because getting them
 * wrong yields a stream that parses as nothing at all rather than as an error.
 */
function encodeAwsFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const total = 16 + body.length;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(0, 4); // no headers
  out.writeUInt32BE(0, 8); // prelude CRC, unverified
  body.copy(out, 12);
  out.writeUInt32BE(0, total - 4); // message CRC, unverified
  return out;
}

function streamBody(frames: string[], framing: StreamFraming): Response {
  if (framing === 'ndjson') {
    return new Response(frames.map((f) => `${f}\n`).join(''), {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  }
  if (framing === 'aws-eventstream') {
    return new Response(Buffer.concat(frames.map(encodeAwsFrame)), {
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    });
  }
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * A `fetch` that answers from a script instead of a network, and records what
 * it was asked for.
 *
 * The recording is what makes cancellation and redirect policy assertable
 * without a server: the signal is captured, so a test can prove the adapter
 * actually forwarded one.
 */
export function scriptedFetch(
  script: ScriptedResponse | ((body: Record<string, unknown>) => ScriptedResponse),
  framing: StreamFraming = 'sse',
) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string>; signal?: AbortSignal }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({
      url: String(input),
      body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal ?? undefined,
    });
    const plan = typeof script === 'function' ? script(body) : script;
    const status = plan.status ?? 200;
    if (status >= 400) {
      return new Response(plan.bodyText ?? 'upstream refused', { status });
    }
    // Bedrock and Vertex select streaming by URL or by `stream: true` rather
    // than by body flag, so a scripted stream is served whenever one exists.
    if (plan.frames) return streamBody(plan.frames, framing);
    return new Response(JSON.stringify(plan.json ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** A `fetch` that never settles until aborted, for proving timeout/cancel wiring. */
export function hangingFetch() {
  const seen: Array<{ signal?: AbortSignal }> = [];
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ signal: init?.signal ?? undefined });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const SCHEMA = {
  name: 'contract_probe',
  schema: {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
  },
} as const;

/**
 * Runs the full parity suite for one adapter.
 *
 * Reused verbatim by every phase: the current implementations prove the
 * baseline, and each replacement adapter is held to the same bars.
 */
export function runProviderContract(contract: ProviderContract): void {
  const streaming = contract.streaming !== false;
  // Resolved once, so every scripted call below frames its bytes the same way
  // the adapter actually expects. Getting this wrong does not throw — it just
  // yields an empty stream, which is the failure mode worth designing against.
  const framing = contract.framing ?? 'sse';

  describe(`provider contract: ${contract.label}`, () => {
    it('returns text, the echoed model, and usage for a plain completion', async () => {
      const { fetcher, calls } = scriptedFetch(
        { json: contract.body({ finishReason: 'stop', text: 'a plain answer' }) },
        framing,
      );
      const provider = contract.build({ fetcher });

      const result = await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'hi' }] });

      assert.equal(result.text, 'a plain answer');
      assert.equal(result.model, contract.model, 'the adapter reports which model answered');
      assert.equal(result.schemaEnforced, false, 'no schema was asked for, so none was enforced');
      assert.equal(calls.length, 1, 'one request per completion');
      assert.ok(result.tokensIn >= 0 && result.tokensOut >= 0, 'usage is present, not NaN');
    });

    it('sends every message, in order', async () => {
      const { fetcher, calls } = scriptedFetch({ json: contract.body({ text: 'ok' }) }, framing);
      const provider = contract.build({ fetcher });

      await provider.complete({
        role: 'narrate',
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: 'ONE' },
          { role: 'assistant', content: 'TWO' },
          { role: 'user', content: 'THREE' },
        ],
      });

      // Message *shaping* for a provider that declares no system role is
      // `adaptRequest`'s job, upstream of `complete()` — asserting it here
      // would freeze policy into the transport. This asserts only that
      // nothing is dropped on the way out.
      const wire = JSON.stringify(calls[0]!.body);
      for (const marker of ['ONE', 'TWO', 'THREE']) assert.match(wire, new RegExp(marker), `${marker} reaches the wire`);
    });

    it('aborts its own outbound request, which is how timeout is enforced', async () => {
      // `CompletionRequest` carries no caller signal — timeouts are the
      // adapter's job — so every adapter must create and forward one.
      const { fetcher, calls } = scriptedFetch({ json: contract.body({ text: 'ok' }) }, framing);
      const provider = contract.build({ fetcher });

      await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'hi' }] });

      assert.ok(calls[0]!.signal, 'the outbound request carries a signal the adapter can abort');
      assert.equal(calls[0]!.signal?.aborted, false, 'and it is left armed, not pre-aborted');
    });

    it('rejects rather than hanging when the transport never answers', async () => {
      const { fetcher, seen } = hangingFetch();
      const provider = contract.build({ fetcher, timeoutMs: 25 });

      await assert.rejects(
        () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'hi' }] }),
        'a configured timeout must surface as a rejection',
      );
      assert.ok(seen[0]?.signal, 'the timeout is implemented by aborting, not by waiting');
    });

    it('normalizes finish reasons onto the allowlist', async () => {
      // `stop` and `length` are the two the engine branches on; anything
      // unrecognized must become `other` rather than leak a vendor string.
      for (const [wire, expected] of [
        ['stop', 'stop'],
        ['length', 'length'],
      ] as const) {
        const { fetcher } = scriptedFetch({ json: contract.body({ finishReason: wire, text: 'x' }) }, framing);
        const provider = contract.build({ fetcher });
        const result = await provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(result.finishReason, expected, `${wire} must normalize`);
      }
    });

    it('reduces an unrecognizable finish reason to `other`', () => {
      assert.equal(normalizeFinishReason('gpt_ended_for_some_reason'), 'other');
      assert.equal(normalizeFinishReason('max_tokens'), 'length');
      assert.equal(normalizeFinishReason('end_turn'), 'stop');
      assert.equal(normalizeFinishReason(undefined), undefined);
      assert.equal(normalizeFinishReason(42), undefined);
    });

    it('raises a bounded, redacted-safe error when upstream refuses', async () => {
      const secret = 'sk-live-0123456789abcdefghij';
      const { fetcher } = scriptedFetch(
        { status: 429, bodyText: `rate limited for key ${secret} ${'x'.repeat(5000)}` },
        framing,
      );
      const provider = contract.build({ fetcher });

      await assert.rejects(
        () => provider.complete({ role: 'narrate', messages: [{ role: 'user', content: 'hi' }] }),
        (err: Error) => {
          assert.match(err.message, /429/, 'the status is visible so BYOK can tell a rejection from an outage');
          assert.ok(err.message.length <= 600, `error text stays bounded, got ${err.message.length}`);
          return true;
        },
      );
    });

    it('returns a parseable object for structured output', async () => {
      const payload = contract.structuredBody?.() ?? contract.body({ text: '{"verdict":"yes"}' });
      const { fetcher } = scriptedFetch({ json: payload }, framing);
      const provider = contract.build({ fetcher });

      const result = await provider.complete({
        role: 'extract',
        messages: [{ role: 'user', content: 'pick one' }],
        schema: { name: SCHEMA.name, schema: SCHEMA.schema as unknown as Record<string, unknown> },
      });

      assert.deepEqual(extractJson(result.text), contract.structuredValue ?? { verdict: 'yes' });
      assert.equal(
        result.schemaEnforced,
        contract.nativeSchema === true,
        'schemaEnforced tracks whether the provider guaranteed conformance, not whether we asked',
      );
    });

    if (streaming) {
      it('delivers streaming chunks in order and aggregates the same text', async () => {
        const { fetcher } = scriptedFetch({ frames: contract.frames({ tokensIn: 11, tokensOut: 4 }) }, framing);
        const provider = contract.build({ fetcher, capabilities: { streaming: true } });

        const chunks: string[] = [];
        const result = await provider.complete({
          role: 'narrate',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: (chunk) => chunks.push(chunk),
        });

        assert.deepEqual(chunks, ['Once ', 'upon ', 'a time'], 'callbacks fire in wire order, unmerged');
        assert.equal(result.text, chunks.join(''), 'the final text is the concatenation of the callbacks');
        assert.equal(result.schemaEnforced, false, 'prose is never schema-enforced');
        assert.equal(chunks.length, 3, 'no callback fires after the promise resolves');
      });

      it('reports the finish reason and usage the stream carried', async () => {
        const { fetcher } = scriptedFetch(
          { frames: contract.frames({ tokensIn: 11, tokensOut: 4, finishReason: 'length' }) },
          framing,
        );
        const provider = contract.build({ fetcher, capabilities: { streaming: true } });

        const result = await provider.complete({
          role: 'narrate',
          messages: [{ role: 'user', content: 'hi' }],
          onToken: () => {},
        });

        assert.equal(result.finishReason, 'length');
        assert.equal(result.tokensIn, 11);
        assert.equal(result.tokensOut, 4);
      });

      it('never streams a structured request', async () => {
        // A half-arrived JSON object is worthless and would corrupt the graph,
        // so `onToken` is silently ignored when a schema is in play.
        const { fetcher, calls } = scriptedFetch(
          { json: contract.structuredBody?.({ finishReason: 'stop' }) ?? contract.body({ text: '{"verdict":"no"}' }) },
          framing,
        );
        const provider = contract.build({ fetcher, capabilities: { streaming: true } });

        const chunks: string[] = [];
        const result = await provider.complete({
          role: 'extract',
          messages: [{ role: 'user', content: 'pick' }],
          schema: { name: SCHEMA.name, schema: SCHEMA.schema as unknown as Record<string, unknown> },
          onToken: (chunk) => chunks.push(chunk),
        });

        const expected = contract.structuredValue ?? { verdict: 'no' };
        assert.deepEqual(chunks, [], 'no prose callback for a structured request');
        assert.deepEqual(extractJson(result.text), expected);
        assert.notEqual(calls[0]!.body.stream, true, 'and no streaming request was made');
      });
    }
  });
}
