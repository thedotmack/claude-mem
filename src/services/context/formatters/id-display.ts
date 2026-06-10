import type { ContextConfig } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_UUID_LENGTH = 8;

/**
 * Format an observation id for display in the injected context panel.
 *
 * When by-id fetch is unsupported (server-beta / Postgres mode, where ids are
 * UUIDs and the inject ref is not a fetch handle), UUID ids are abbreviated to
 * their 8-char prefix to cut tokenizer cost — full UUIDs fragment badly and are
 * the worst case for the tokenizer. These short refs are display-only; lookups
 * go by title/semantic search and the full UUID still lives in search results
 * where tokens are not the bottleneck. Everything else (numeric SQLite ids,
 * fetch-by-id modes) is left unchanged.
 */
export function formatContextReferenceId(
  id: string | number,
  config: Pick<ContextConfig, 'fetchByIdSupported'>
): string {
  const value = String(id);
  if (config.fetchByIdSupported === false && UUID_RE.test(value)) {
    return value.slice(0, SHORT_UUID_LENGTH);
  }
  return value;
}
