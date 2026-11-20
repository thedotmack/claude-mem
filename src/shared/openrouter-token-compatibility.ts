import { MAX_ERROR_BODY_BYTES } from './capped-error-body.js';

async function inspectResponseHead(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let remaining = MAX_ERROR_BODY_BYTES;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      text += decoder.decode(chunk, { stream: true });
      remaining -= chunk.byteLength;
    }
    return text + decoder.decode();
  } finally {
    // A clone is one branch of a tee. Awaiting its cancellation can wait for
    // the original response, which the caller cannot consume until we return.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function isMaxCompletionTokensCompatibilityError(status: number, bodyText: string): boolean {
  let error: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)) {
      error = parsed.error as Record<string, unknown>;
    }
  } catch {
    // Fall through to the bounded text check for non-JSON 400 responses.
  }

  const message = typeof error?.message === 'string' ? error.message : bodyText;
  const mentionsReplacement = /unsupported\s+parameter[\s\S]*max_tokens[\s\S]*(?:use|replace)[\s\S]*max_completion_tokens/i.test(message);
  const hasStructuredFields = error?.param === 'max_tokens'
    && /max_completion_tokens/i.test(bodyText)
    && (error.code === 'unsupported_parameter' || error.code === 400 || error.code === '400');

  if (status === 400) {
    return mentionsReplacement || hasStructuredFields;
  }

  return status >= 200 && status < 300 && !!error && (mentionsReplacement || hasStructuredFields);
}

export async function fetchWithOpenRouterTokenCompatibility(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  body: Record<string, unknown>,
  maxOutputTokens: number,
  /** False for image requests: max_completion_tokens is never sent with images. */
  allowMaxCompletionTokensRetry: boolean = true,
): Promise<Response> {
  const initialBody = { ...body, max_tokens: maxOutputTokens };
  const response = await fetchImpl(input, { ...init, body: JSON.stringify(initialBody) });
  if (!allowMaxCompletionTokensRetry) return response;
  if (response.status !== 400 && (response.status < 200 || response.status >= 300 || response.status === 204 || response.status === 205)) {
    return response;
  }

  let bodyText = '';
  try {
    bodyText = await inspectResponseHead(response);
  } catch {
    return response;
  }

  if (!isMaxCompletionTokensCompatibilityError(response.status, bodyText)) {
    // Inspect only the clone: reconstructing a Response discards fetch URL,
    // redirect and response-type metadata even when no retry is needed.
    return response;
  }

  // The first response will not be returned after a retry. Release its tee
  // branch too so an oversized compatibility error cannot keep streaming.
  void response.body?.cancel().catch(() => {});
  const { max_tokens: _ignored, ...bodyWithoutMaxTokens } = body;
  return fetchImpl(input, {
    ...init,
    body: JSON.stringify({ ...bodyWithoutMaxTokens, max_completion_tokens: maxOutputTokens }),
  });
}
