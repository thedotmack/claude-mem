export const DEFAULT_CHAT_TITLE = "New chat";

export function createFallbackTitle(input: string) {
  const text = input
    .replace(/\s+/g, " ")
    .replace(/[`*_#>]/g, "")
    .trim();

  if (!text) {
    return DEFAULT_CHAT_TITLE;
  }

  return truncateTitle(text);
}

function truncateTitle(title: string) {
  return title.length > 72 ? `${title.slice(0, 69).trimEnd()}...` : title;
}
