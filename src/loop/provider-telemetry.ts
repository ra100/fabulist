/** Privacy-safe timing data for one text-provider attempt. */
export interface ProviderCallTelemetry {
  role: string;
  provider: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs: number;
  ok: boolean;
  errorKind?: string;
}

/** Error names are useful for diagnosis without recording provider messages. */
export function providerErrorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}
