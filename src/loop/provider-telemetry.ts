import { providerErrorReason } from '../providers/byok.ts';
import { ProviderHttpError, type ProviderFinishReason } from '../providers/provider.ts';

/** Privacy-safe timing data for one text-provider attempt. */
export interface ProviderCallTelemetry {
  role: string;
  provider: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Character counts only; generated text is never logged. */
  responseChars?: number;
  streamChars?: number;
  /** Per-role retry number and requested output budget; no prompt data is recorded. */
  attempt?: number;
  maxTokens?: number;
  streaming?: boolean;
  finishReason?: ProviderFinishReason;
  durationMs: number;
  ok: boolean;
  errorKind?: string;
  /** HTTP status of a provider refusal. */
  errorStatus?: number;
  /**
   * The provider's own short error message, or a network error code. Never the
   * error's full text, which for a parse failure can quote generated output.
   */
  errorDetail?: string;
}

/** Error names are useful for diagnosis without recording provider messages. */
export function providerErrorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

/**
 * What `ai.call` records about a failure: the error class, plus the status and
 * the provider's stated reason when it refused the request. Without those, a
 * 400 for a bad model id and a dropped connection both log as `Error`.
 */
export function providerErrorFields(error: unknown): Pick<ProviderCallTelemetry, 'errorKind' | 'errorStatus' | 'errorDetail'> {
  const errorKind = providerErrorKind(error);
  if (error instanceof ProviderHttpError) {
    const errorDetail = providerErrorReason(error.body);
    return { errorKind, errorStatus: error.status, ...(errorDetail ? { errorDetail } : {}) };
  }
  const code = errorCode(error) ?? errorCode(error instanceof Error ? error.cause : undefined);
  return code ? { errorKind, errorDetail: code } : { errorKind };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}
