const UNSUPPORTED_MAX_TOKENS_ERROR = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";

export function isMaxCompletionTokensCompatibilityError(status: number, bodyText: string): boolean {
  return status === 400 && bodyText.includes(UNSUPPORTED_MAX_TOKENS_ERROR);
}

export async function fetchWithOpenRouterTokenCompatibility(
  fetchImpl: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  body: Record<string, unknown>,
): Promise<Response> {
  const response = await fetchImpl(input, { ...init, body: JSON.stringify(body) });
  if (response.status !== 400) {
    return response;
  }

  const bodyText = await response.clone().text();
  if (!isMaxCompletionTokensCompatibilityError(response.status, bodyText) || !Object.prototype.hasOwnProperty.call(body, 'max_tokens')) {
    return response;
  }

  const { max_tokens, ...preservedBody } = body;
  return fetchImpl(input, {
    ...init,
    body: JSON.stringify({ ...preservedBody, max_completion_tokens: max_tokens }),
  });
}
