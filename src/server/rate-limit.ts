/**
 * How many paid calls one caller may make.
 *
 * "Paid" means the request reaches a model or image provider billed to this
 * server's operator, or crawls somebody else's wiki on its behalf. On a public
 * instance any account can sign up and make those, so an unmetered account is
 * an open tab on the operator's API keys.
 *
 * A token bucket per caller: `burst` calls at once, refilled continuously at
 * `perMinute`. In memory, per process — this bounds one account's rate, it is
 * not a quota. It does not survive a restart and it does not add up across
 * accounts, which is what provider-side spend limits are for.
 */

export interface PaidCallLimit {
  /** How many paid calls may be made back to back. At least 1. */
  burst: number;
  /** The sustained rate the bucket refills at. */
  perMinute: number;
}

/**
 * Generous for a person: a turn every two seconds for a minute before any wait,
 * and a turn every two seconds sustained. A signed-in account spending faster
 * than that is not reading what it writes.
 */
export const DEFAULT_PAID_CALL_LIMIT: PaidCallLimit = { burst: 20, perMinute: 30 };

/** Buckets kept before idle, full ones are dropped, so one-off callers do not accumulate. */
const PRUNE_AT = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly burst: number;
  private readonly perMs: number;
  private readonly now: () => number;

  constructor(burst: number, perMinute: number, now: () => number = Date.now) {
    if (!(burst >= 1) || !(perMinute > 0)) throw new RangeError('a rate limit needs burst >= 1 and perMinute > 0');
    this.burst = burst;
    this.perMs = perMinute / 60_000;
    this.now = now;
  }

  /** Spends one call for `key`: `null` when allowed, else whole seconds until one would be. */
  take(key: string): number | null {
    const at = this.now();
    const bucket = this.buckets.get(key);
    const tokens = bucket ? Math.min(this.burst, bucket.tokens + (at - bucket.at) * this.perMs) : this.burst;
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, at });
      if (this.buckets.size > PRUNE_AT) this.prune(at);
      return null;
    }
    this.buckets.set(key, { tokens, at });
    return Math.max(1, Math.ceil((1 - tokens) / this.perMs / 1000));
  }

  private prune(at: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (at - bucket.at) * this.perMs >= this.burst) this.buckets.delete(key);
    }
  }
}

function wholeNumber(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new Error(`${name} must be a whole number >= ${min}, got "${raw}"`);
  return value;
}

/**
 * The operator's override, if any: `undefined` when neither variable is set (use
 * the server default), `null` when `FABULIST_PAID_CALLS_PER_MINUTE=0` turns
 * metering off. A malformed value throws, so a typo fails the boot rather than
 * silently running unmetered.
 */
export function paidCallLimitFromEnv(env: Record<string, string | undefined>): PaidCallLimit | null | undefined {
  const perMinute = env.FABULIST_PAID_CALLS_PER_MINUTE;
  const burst = env.FABULIST_PAID_CALLS_BURST;
  if (perMinute === undefined && burst === undefined) return undefined;
  const limit = {
    perMinute: wholeNumber('FABULIST_PAID_CALLS_PER_MINUTE', perMinute, DEFAULT_PAID_CALL_LIMIT.perMinute, 0),
    burst: wholeNumber('FABULIST_PAID_CALLS_BURST', burst, DEFAULT_PAID_CALL_LIMIT.burst, 1),
  };
  return limit.perMinute === 0 ? null : limit;
}
