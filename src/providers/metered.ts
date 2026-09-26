import { ProviderKeyLockedError, ProviderKeyRejectedError, scrubSecrets } from './byok.ts';
import type { CompletionRequest, CompletionResult, Provider, Registry } from './provider.ts';

export type UsageSink = (call: {
  role: string;
  providerId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}) => Promise<void>;

function metered(inner: Provider, sink: UsageSink): Provider {
  return {
    id: inner.id,
    model: inner.model,
    capabilities: inner.capabilities,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      let result: CompletionResult;
      try {
        result = await inner.complete(req);
      } catch (err) {
        if (err instanceof ProviderKeyLockedError || err instanceof ProviderKeyRejectedError) throw err;
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err)));
      }
      if (inner.id !== 'mock') {
        await sink({
          role: req.role,
          providerId: inner.id,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        }).catch((err: unknown) =>
          console.error('[usage] could not record a provider call:', err instanceof Error ? err.message : err),
        );
      }
      return result;
    },
  };
}

/** One wrapper around every provider the resolver hands out, so no call site has to remember to meter. */
export class MeteredRegistry implements Registry {
  private readonly inner: Registry;
  private readonly sink: UsageSink;

  constructor(inner: Registry, sink: UsageSink) {
    this.inner = inner;
    this.sink = sink;
  }

  get(role: string): Provider {
    return metered(this.inner.get(role), this.sink);
  }

  all(): Provider[] {
    return this.inner.all().map((p) => metered(p, this.sink));
  }
}
