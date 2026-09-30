# Provider transport migration: allowed APIs, retained paths, and the parity contract

Issue #172 (plan) → #165 (phase 0). This file is the record the later phases are
judged against. Everything in the "verified" sections below was confirmed by
compiling a type-level probe against the *installed* packages, not by reading
documentation.

## Pinned versions

Exact-pinned (`-E`), so a transitive bump cannot change transport behaviour
underneath a parity contract.

| Package | Version | Used for |
| --- | --- | --- |
| `ai` | `7.0.124` | `generateText`, `streamText`, `Output.object`, `jsonSchema` |
| `@ai-sdk/openai-compatible` | `3.0.61` | OpenAI-shaped chat completions (phases 1–2) |
| `@ai-sdk/anthropic` | `4.0.70` | Anthropic Messages (phase 3) |
| `@ai-sdk/amazon-bedrock` | `5.0.103` | Bedrock Converse text (phase 4) |
| `@ai-sdk/google-vertex` | `5.0.100` | Vertex Gemini (phase 5) |

## Verified API surface

Confirmed by `tsc --strict` against the installed packages. Anything not listed
here is off-limits until re-verified the same way.

### `ai`

- `Output.object({ schema })` returns a native structured-output descriptor.
  The **type** is exported as `OutputInterface`, not `Output` — `Output` resolves
  to the namespace that *holds* `object`. Importing the wrong one is a compile
  error, not a runtime one.
- `generateText({ model, messages, output, temperature, maxOutputTokens, abortSignal })`
  resolves to `{ text, output, finishReason, rawFinishReason, usage, response }`.
- There is **no** top-level `modelId`. The model is at `result.response.modelId`.
- `usage` is `{ inputTokens, outputTokens, totalTokens }`.
- `streamText({ ..., onChunk })` takes `onChunk({ chunk })`, not `onToken`. Text
  arrives as `chunk.type === 'text-delta'`.
- `streamText`'s `usage` and `finishReason` are **promises**; `generateText`'s
  are plain values.
- `abortSignal` is the cancellation seam.

### `@ai-sdk/openai-compatible` / provider factories

- `createOpenAICompatible({ name, baseURL, apiKey, fetch, includeUsage, supportsStructuredOutputs, transformRequestBody, convertUsage })`.
- **`headers` is a static `Record<string, string>`** — there is no dynamic-header
  seam at provider settings *or* at model-call settings (`chatModel(id)` takes
  one argument). This was the single most consequential finding.
- `transformRequestBody` and `convertUsage` exist and are the sanctioned way to
  absorb dialect differences (vLLM's `guided_json`, llama.cpp's bare
  `json_schema`, non-standard token accounting) rather than forking the adapter.

## Consequences for BYOK credential handling

Because there is no dynamic header seam, **the injected `fetch` is the only place
call-scoped credentials can enter.** This is not a workaround — it is the same
boundary Fabulist already uses for `fetcher`, and it keeps the "read the key per
call, never retain it" property intact. The adapter wraps `fetch` and sets the
`Authorization` header per invocation.

The rule that follows: **never** construct a long-lived SDK provider holding a
resolved API key, and never log or capture the wrapped key.

## What stays application-owned

None of this is delegated to an SDK. An SDK transport library has no opinion
about any of it:

- `Provider` / `CompletionRequest` / `CompletionResult` / `ProviderCapabilities`
  and `normalizeFinishReason` — the contract itself.
- `adaptRequest` — capability degradation (system-role folding, JSON instruction).
- `extractJson` — recovery for fenced or preamble-laden JSON.
- Provider *registry* and per-role routing (`ProviderRegistry`, `SwappableRegistry`).
- BYOK lifecycle: `byokProvider`, call-scoped `secret()`, `noRedirects`,
  `scrubSecrets`, `providerErrorReason`, `ProviderKeyRejectedError`.
- Usage metering (`providers/metered.ts`) and attribution (`usageKeyId`).
- Resolvers (`resolver-pg.ts`), probes, and fallback policy.
- Prose-only streaming policy: never stream a structured request.
- Image generation, JEV typed decisions, and GitHub Copilot.

## Retained custom paths

No supported module provides parity here, so these keep bespoke code:

| Path | Why |
| --- | --- |
| GitHub Copilot | OAuth token exchange + bespoke endpoint. No official AI SDK module. Unofficial Copilot packages are explicitly not adopted. |
| Image generation | Separate model surface (`bedrockImage`, illustration hosts); `generateImage`/image models are out of scope for the text migration. |
| JEV | Typed-decision endpoints return calibrated probabilities, not chat completions. `JevProvider` / `JevCompatProvider` stay. |
| Ollama | `/api/chat` + `format` + NDJSON. No AI SDK module; kept behind its own adapter. |
| Unsupported OpenAI dialects | vLLM (`guided_json`) and llama.cpp (bare `json_schema`) keep explicit routing until fixture coverage proves otherwise. |
| Bedrock image signing | SigV4 stays for images; text signing is replaced in phase 4 only. |

## The parity contract

`test/contract/provider-contract.ts` is the executable definition.
`test/contract/baseline.test.ts` runs it against the current adapters for all
five providers (OpenAI-compat, Anthropic, Ollama, Bedrock, Vertex), and every
later phase runs the *same* suite against its replacement.

Asserted, behaviourally, through `Provider.complete()` only:

- plain text, echoed model, and usage
- every message reaching the wire, in order
- self-abort (how timeout is enforced) and rejection on a hanging transport
- finish-reason normalization onto the allowlist
- bounded, status-bearing errors on upstream refusal
- structured output parses, and `schemaEnforced` tracks *guarantee*, not intent
- streaming callback order, unmerged, with the final text as their concatenation
- finish reason and usage carried across a stream
- structured requests are never streamed

Deliberately **not** asserted: wire-format details (`response_format`,
`guided_json`, `stream_options`, request paths). Asserting those would re-freeze
the exact thing these phases exist to change.

## Findings from phase 0

Writing the contract against the current code found two real gaps, both now
fixed, and confirmed one property that was previously only assumed:

1. **Anthropic, Ollama, Bedrock and Vertex all dropped `finishReason`.** Only
   `OpenAICompatProvider` reported one, while `loop/roles.ts` and
   `observability.ts` consume the field for diagnostics. Every adapter now
   normalizes and returns it, on both the completion and streaming paths.
2. **`normalizeFinishReason` could not read Gemini's vocabulary.** Vertex
   reports `STOP` / `MAX_TOKENS` / `SAFETY`, none of which matched, so every
   Vertex stop reason silently degraded to `other`. Those spellings are now
   recognized.
3. **Bounded errors were true but untested.** All six error paths already
   truncated the upstream body to 300 characters (`OllamaProvider` includes no
   body at all). The contract now proves it on every provider rather than
   leaving it to inspection.

   This matters more than it looks: the SDK's `APICallError` carries an
   **untruncated** `responseBody` *and* a `requestBodyValues` holding the entire
   prompt. Any replacement that surfaces `err.message` verbatim would regress
   boundedness and ship prose to the logs. Every SDK adapter must rebuild its
   error from `statusCode` plus a truncated body, and must never let
   `requestBodyValues` escape. `scrubSecrets` stays the last gate.

Routing, capability policy, credential handling, and metering are unchanged.

## Findings from phase 1

Running the phase 0 contract against `OpenAISdkProvider` found four SDK-7
behaviours that differ from the hand-rolled adapter. All four are the kind that
passes a smoke test and fails in production.

1. **System messages are rejected outright.** AI SDK 7 refuses `role: 'system'`
   inside `messages` unless `allowSystemInMessages: true`. Without it, *every*
   provider declaring `systemRole: true` — which is most of them — throws
   `InvalidPromptError` on the first turn. Set explicitly, because moving
   system turns to `instructions` would re-order them against the conversation
   that `adaptRequest` was written to produce.
2. **The SDK retries by default (`maxRetries: 2`).** A 429 took 6s instead of
   failing fast, and each retry is a billable call that Fabulist's meter would
   count separately. Pinned to `0`: retry policy is the caller's, not the
   transport's.
3. **`result.output` is only a promise when an output spec was supplied.**
   Calling `.catch` on it unconditionally throws `TypeError`. The guard also
   lets a shape mismatch fall through as text, preserving the existing
   behaviour where Fabulist's own validator decides whether to repair or fail.
4. **This provider requires a `finish_reason` to terminate a stream**, whereas
   the hand-rolled adapter never needed one.

Plus one that is ours rather than the SDK's: a provider that echoes a rejected
key back in its error body would have leaked it, since the hand-rolled adapter
quotes a truncated upstream body verbatim. The SDK adapter now scrubs the key it
resolved, so `byok.ts`'s shape-based gate is a second line rather than the only
one. This makes the SDK adapter *safer* than the one it replaces — recorded
deliberately, not as parity.

## Phase 1 status

`transport: 'sdk'` on an `openai-compat` spec opts that one spec onto the SDK
adapter. `transport: 'sdk'` is refused for the `vllm` and `llamacpp` dialects
rather than sending a `response_format` those endpoints ignore.

## Phase 2: the decision table

The SDK adapter is now the default for compatible OpenAI-shaped endpoints.
`resolveTransport` is the table, and it prefers a *stated* difference over an
inferred one — a base URL says nothing about behaviour, while `dialect` exists
precisely to record "OpenAI-shaped but not OpenAI-behaved".

| Endpoint class | Transport | Why |
| --- | --- | --- |
| standard chat completions | `sdk` | `/chat/completions` with `response_format` is what it speaks |
| configured gateway (any baseUrl, no dialect) | `sdk` | the base URL does not change the wire shape |
| vLLM | `legacy` | constrains via `guided_json`, silently ignores `response_format` |
| llama.cpp | `legacy` | takes a bare schema under `json_schema` |
| Ollama | `legacy` | a different kind: `/api/chat`, `format`, NDJSON stream |

Precedence: explicit `transport` (that is the per-target rollback), then
`dialect`, then `FABULIST_PROVIDER_TRANSPORT=legacy`, then `sdk`. Asking for
`sdk` *and* a dialect is a contradiction and throws rather than silently
honouring either.

BYOK routes through the same adapter. The per-call `secret()` read is preserved
by handing the SDK adapter a resolver rather than a value, so a lock or delete
between two calls of one turn still stops the second call.

Rollback for one release cycle: `transport: 'legacy'` on a single spec, or
`FABULIST_PROVIDER_TRANSPORT=legacy` for everything at once.

### Findings from phase 2

1. **`streamText` swallows the API error.** With no `onError` handler, a 401
   during a streaming turn surfaces as `NoOutputGeneratedError` — "no output
   generated. Check the stream for errors." `byok.ts` decides "your key was
   rejected" from `status`, so a rejected key during narration would have been
   reported as an empty turn and sent to the user as a quiet, blank scene. The
   adapter now captures `onError` and rebuilds the `ProviderHttpError`. This
   is the single most dangerous difference the contract suite caught, and it
   was invisible until a BYOK test exercised the streaming error path.
2. **The BYOK test doubles were not `Response`s.** They returned
   `{ ok, status, json }`, which no SDK can consume. They now build real
   `Response` objects, so those tests prove something about the path that ships
   rather than about the transport that was replaced.
3. **A test double that returns a model-list body for a chat request** was
   tolerated by the hand-rolled adapter and rejected by the SDK. The
   hand-rolled adapter was reading `choices[0].message.content` out of a
   `{ data: [] }` payload and getting `''`. Fixed in the double.

## Phase 3: Anthropic Messages

`AnthropicSdkProvider` replaces the transport in `AnthropicProvider`, which
stays for one release cycle as the `transport: 'legacy'` rollback. Two
Anthropic-specific behaviours are preserved deliberately:

- The system prompt is a **top-level field, not a message**, joined with blank
  lines. The SDK sends it as a content block rather than a bare string; both are
  valid on this API and the text is identical, so nothing downstream changes.
- A provider declaring `structuredOutput: 'none'` — which is Anthropic's shipped
  preset — still gets the **prefilled assistant brace**, and the brace is
  restored on the way back. Tool use is not forced onto a model documented to
  reject it; `Output.object` is used only where a spec declares native schema
  support.

### Findings from phase 3

1. **`createAnthropic` refuses to construct without an apiKey.** `loadApiKey`
   throws before the fetch wrapper is ever reached. The adapter passes a
   placeholder and the wrapper deletes it before setting the real per-call key,
   and *fails closed* — with no key the request goes out unauthenticated rather
   than carrying the placeholder. `createOpenAICompatible` does not have this
   requirement, which is why the OpenAI adapter needed nothing.
2. **The SDK's Anthropic stream parser tracks message state across events.** A
   three-frame fixture (`message_start`, deltas, `message_delta`) parses as
   "no usage, no finish reason" rather than as an error — the parser needs
   `message_start.message.id` before it accepts a `content_block_delta`, and
   `content_block_start` / `message_stop` to close the message. A contract that
   passed because a stub happened to be forgiving would have hidden that.
3. **Two contract fixtures passed through the wrong finish-reason vocabulary.**
   `body()` is handed a *Fabulist* finish reason, and Anthropic and Bedrock both
   want `max_tokens` where the contract was sending `length`. The hand-rolled
   adapters tolerated it because they passed the string through
   `normalizeFinishReason`; the SDK parses Anthropic's own vocabulary. Corrected
   in the fixtures, and it is now visible that each provider declares its wire
   vocabulary explicitly.
4. **Anthropic's Messages API and OpenAI's chat API are not the same JSON**, and
   the SDK's parser is strict where the hand-rolled adapter was forgiving. The
   BYOK test double now answers per endpoint instead of returning an OpenAI
   body for Anthropic.

## Phase 3 rollback

`transport: 'legacy'` on an Anthropic spec, or `FABULIST_PROVIDER_TRANSPORT=legacy`
for all of them. `AnthropicProvider` is referenced only by that path and by its
own unit tests, so removing it in phase 6 is a deletion, not a refactor.



