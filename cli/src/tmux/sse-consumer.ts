/**
 * SSE event stream consumer for the memory worker.
 * Connects to GET /stream and yields parsed SSE events.
 */

export interface SSEOptions {
  baseUrl: string;
  onEvent: (event: { type: string; data: Record<string, unknown> }) => void;
  onError: (error: Error) => void;
  onConnect: () => void;
  signal?: AbortSignal;
}

/**
 * Parse a single SSE message block (delimited by double newline).
 * Returns null if the block is empty or comment-only.
 */
function parseSSEBlock(block: string): { type: string; data: Record<string, unknown> } | null {
  let eventType = 'message';
  let dataRaw = '';

  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataRaw += line.slice('data:'.length).trim();
    }
    // ignore id: and retry: fields for now
  }

  if (!dataRaw) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(dataRaw) as Record<string, unknown>;
  } catch {
    // Non-JSON data — wrap as { raw } to stay typed
    parsed = { raw: dataRaw };
  }

  return { type: eventType, data: parsed };
}

/**
 * Consume an SSE stream from the memory worker's GET /stream endpoint.
 * Resolves when the stream closes or the abort signal fires.
 * Never throws — errors are delivered via onError.
 */
export async function consumeSSE(options: SSEOptions): Promise<void> {
  const { baseUrl, onEvent, onError, onConnect, signal } = options;
  const url = `${baseUrl}/stream`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok) {
    onError(new Error(`SSE connection failed: HTTP ${response.status}`));
    return;
  }

  if (!response.body) {
    onError(new Error('SSE response has no body'));
    return;
  }

  onConnect();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE messages are delimited by "\n\n"
      const blocks = buffer.split('\n\n');
      // Keep the last (possibly incomplete) block in the buffer
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // skip comments/keepalives
        const parsed = parseSSEBlock(trimmed);
        if (parsed) {
          onEvent(parsed);
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore cleanup errors
    }
  }
}
