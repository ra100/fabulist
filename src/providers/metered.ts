import { ProviderKeyLockedError, ProviderKeyRejectedError } from './byok.ts';
import { scrubProviderError, type CompletionRequest, type CompletionResult, type Provider, type Registry } from './provider.ts';

export type UsageSink = (call: {
  role: string;
  providerId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  keyId?: string;
  keySource?: 'own' | 'server';
}) => Promise<void>;

const pending = new Set<Promise<void>>();

/** Resolves once every usage write started so far has landed (tests and shutdown). */
export async function usageSettled(): Promise<void> {
  await Promise.allSettled([...pending]);
}

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
        throw scrubProviderError(err);
      }
      if (inner.id !== 'mock') {
        // Not awaited: the caller may hold a pooled connection in a tx, and waiting on a second one can deadlock the pool.
        const write = sink({
          role: req.role,
          providerId: inner.id,
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          ...(inner.usageKeyId ? { keyId: inner.usageKeyId } : {}),
          ...(inner.usageKeySource ? { keySource: inner.usageKeySource } : {}),
        })
          .catch((err: unknown) =>
            console.error('[usage] could not record a provider call:', err instanceof Error ? err.message : err),
          )
          .finally(() => pending.delete(write));
        pending.add(write);
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

  getOptional(role: string): Provider | undefined {
    const provider = this.inner.getOptional?.(role);
    return provider ? metered(provider, this.sink) : undefined;
  }

  all(): Provider[] {
    return this.inner.all().map((p) => metered(p, this.sink));
  }
}
