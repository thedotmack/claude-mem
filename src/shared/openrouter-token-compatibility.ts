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
): Promise<Response> {
  const initialBody = { ...body, max_tokens: maxOutputTokens };
  const response = await fetchImpl(input, { ...init, body: JSON.stringify(initialBody) });
  if (response.status !== 400 && (response.status < 200 || response.status >= 300 || response.status === 204 || response.status === 205)) {
    return response;
  }

  let bodyText = '';
  let responseForCaller = response;
  try {
    bodyText = await response.text();
    responseForCaller = new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return response;
  }

  if (!isMaxCompletionTokensCompatibilityError(response.status, bodyText)) {
    return responseForCaller;
  }

  return fetchImpl(input, {
    ...init,
    body: JSON.stringify({ ...body, max_completion_tokens: maxOutputTokens }),
  });
}
