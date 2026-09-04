/**
 * Server-sent-event reading, shared by every streaming provider.
 *
 * Each vendor streams a different payload shape over the same transport, so the
 * transport lives here once and the shape stays with each adapter. The framing
 * detail that matters: an SSE chunk from `fetch` is not guaranteed to align with
 * event boundaries, so a partial line has to be carried between reads. Getting
 * that wrong produces prose with occasional missing fragments, which is very hard
 * to spot and very easy to blame on the model.
 */

export interface StreamOptions {
  signal?: AbortSignal;
}

/** Yields each `data:` payload from an SSE body, in order. */
export async function* readSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line, but many servers send one event per
      // line; splitting on newline and skipping blanks handles both.
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') yield payload;
        }
        newline = buffer.indexOf('\n');
      }
    }
    // A final event with no trailing newline.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Reads newline-delimited JSON, which is what Ollama streams. */
export async function* readNdjson(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/**
 * AWS event streams are binary framed, not SSE: each message carries a prelude,
 * headers and a payload. Only the payload JSON is wanted, and it is base64-encoded
 * inside a `bytes` field, so a tolerant scan is both simpler and more robust than
 * a full frame parser for this one use.
 */
export async function* readAwsEventStream(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Pull out every complete {"bytes":"..."} object seen so far.
      const pattern = /\{"bytes":"([A-Za-z0-9+/=]+)"[^}]*\}/g;
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      while ((match = pattern.exec(buffer))) {
        lastIndex = match.index + match[0].length;
        try {
          yield Buffer.from(match[1]!, 'base64').toString('utf8');
        } catch {
          // A truncated frame; the next read will complete it.
        }
      }
      if (lastIndex > 0) buffer = buffer.slice(lastIndex);
      // Do not let an unparseable tail grow without bound.
      if (buffer.length > 1_000_000) buffer = buffer.slice(-4096);
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
