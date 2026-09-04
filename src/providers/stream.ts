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
 * Reads AWS's `application/vnd.amazon.eventstream` binary framing, used by
 * Bedrock's `converse-stream`.
 *
 * This is not the earlier `{"bytes":"<base64>"}` shape it used to assume — that
 * is a different AWS service's convention (Kinesis / S3 Select). Bedrock's own
 * wire format is: a 12-byte prelude (4-byte total length, 4-byte headers
 * length, 4-byte prelude CRC, big-endian), then that many bytes of headers,
 * then the payload — which for Bedrock is the event JSON directly, not
 * base64 — then a trailing 4-byte message CRC. Getting this wrong does not
 * throw: it silently yields nothing, which is how this shipped for a while
 * with every turn narrating as empty prose while the non-streaming path
 * (identical model, identical prompt) worked perfectly.
 *
 * CRCs are read past but not verified: a corrupt frame surviving a TLS
 * connection intact is not a failure mode worth coding a checksum for here.
 */
export async function* readAwsEventStream(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  let buffer = Buffer.alloc(0);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer = Buffer.concat([buffer, Buffer.from(value)]);

      // A frame needs at least its 12-byte prelude to know its own length.
      for (;;) {
        if (buffer.length < 12) break;
        const totalLength = buffer.readUInt32BE(0);
        if (buffer.length < totalLength) break; // the rest of this frame has not arrived yet

        const headersLength = buffer.readUInt32BE(4);
        const payloadStart = 12 + headersLength;
        const payloadEnd = totalLength - 4; // the trailing 4 bytes are the message CRC
        if (payloadEnd > payloadStart) {
          yield buffer.subarray(payloadStart, payloadEnd).toString('utf8');
        }
        buffer = buffer.subarray(totalLength);
      }

      if (done) break;
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
