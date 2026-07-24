export const DEFAULT_MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';

export function resolveMiniMaxChatCompletionsUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, '') ?? '';
  if (!trimmed) return DEFAULT_MINIMAX_API_URL;
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}
