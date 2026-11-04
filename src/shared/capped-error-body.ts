/** Error bodies are read at most this far: the classifiers need the head, never megabytes. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Read at most MAX_ERROR_BODY_BYTES of a failed response's body as text, then
 * cancel the rest. An error path must not buffer an unbounded body (a proxy's
 * HTML page, a gateway echoing the whole request) to classify it. Shared by the
 * worker providers and the server generation providers.
 */
export async function readCappedErrorBody(response: Response, maxBytes: number = MAX_ERROR_BODY_BYTES): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const remainingBytes = maxBytes - bytesRead;
      const chunk = value.byteLength > remainingBytes ? value.subarray(0, remainingBytes) : value;
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    await reader.cancel();
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
