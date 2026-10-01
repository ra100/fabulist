import { providerErrorReason } from '../providers/byok.ts';
import { ProviderHttpError, scrubSecrets, type CompletionRequest, type ProviderFinishReason } from '../providers/provider.ts';

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
  /** The error message, capped, with key-shaped strings and anything echoed from the request redacted. */
  errorDetail?: string;
}

/** Error names are useful for diagnosis without recording provider messages. */
export function providerErrorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

/** Longest error text `ai.call` keeps. */
const ERROR_DETAIL_MAX = 300;
/** A run this long copied from the request is treated as the request's content. */
const ECHO_MIN = 12;

/**
 * What `ai.call` records about a failure: the error class, the HTTP status, and
 * the error's message. Without those, a 400 for a bad model id and a dropped
 * connection both log as `Error`.
 *
 * The message is provider text, and providers do echo what they were sent
 * ("invalid value for state: …"), so any run of it copied from the request's
 * messages is redacted, as are key-shaped strings. What remains is the
 * provider's own wording, which is what diagnosis needs.
 */
export function providerErrorFields(
  error: unknown,
  req?: Pick<CompletionRequest, 'messages'>,
): Pick<ProviderCallTelemetry, 'errorKind' | 'errorStatus' | 'errorDetail'> {
  const errorKind = providerErrorKind(error);
  const sent = (req?.messages ?? []).map((message) => message.content);
  let text: string;
  let errorStatus: number | undefined;
  if (error instanceof ProviderHttpError) {
    errorStatus = error.status;
    // The provider's stated reason when its body has one; the message also
    // carries the URL and a body excerpt, which is the fallback.
    text = providerErrorReason(error.body) || error.message;
  } else {
    text = error instanceof Error ? error.message : String(error);
    const code = errorCode(error) ?? errorCode(error instanceof Error ? error.cause : undefined);
    if (code) text = `${text} (${code})`;
  }
  const errorDetail = redactEchoes(scrubSecrets(text.slice(0, ERROR_DETAIL_MAX * 2)), sent).slice(0, ERROR_DETAIL_MAX).trim();
  return {
    errorKind,
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    ...(errorDetail ? { errorDetail } : {}),
  };
}

/**
 * Replaces every stretch of `text` that also appears in one of `sources` (at
 * least `ECHO_MIN` characters long) with `[redacted]`. Compared on lowercased,
 * whitespace-collapsed text, so a provider re-wrapping or re-casing an echo
 * does not let it through.
 */
export function redactEchoes(text: string, sources: readonly string[]): string {
  if (!text || sources.length === 0) return text;
  const fold = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');
  // Positions are tracked on the folded text, so fold it once and keep a map
  // back to the original characters.
  const kept: number[] = [];
  let folded = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (/\s/.test(ch)) {
      if (folded.endsWith(' ')) continue;
      folded += ' ';
    } else {
      folded += ch.toLowerCase();
    }
    kept.push(i);
  }
  if (folded.length < ECHO_MIN) return text;
  const windows = new Set<string>();
  for (const source of sources) {
    const value = fold(source);
    for (let i = 0; i + ECHO_MIN <= value.length; i++) windows.add(value.slice(i, i + ECHO_MIN));
  }
  const hidden = new Array<boolean>(text.length).fill(false);
  let any = false;
  for (let i = 0; i + ECHO_MIN <= folded.length; i++) {
    if (!windows.has(folded.slice(i, i + ECHO_MIN))) continue;
    any = true;
    const from = kept[i] ?? 0;
    const to = kept[i + ECHO_MIN - 1] ?? from;
    for (let j = from; j <= to; j++) hidden[j] = true;
  }
  if (!any) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (!hidden[i]) out += text[i];
    else if (!hidden[i - 1]) out += '[redacted]';
  }
  return out;
}
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}
