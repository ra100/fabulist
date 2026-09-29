import type { ProviderFinishReason } from '../providers/provider.ts';

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
}

/** Error names are useful for diagnosis without recording provider messages. */
export function providerErrorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}
