import type { ContextConfig } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_UUID_LENGTH = 8;

export function formatContextReferenceId(
  id: string | number,
  config: Pick<ContextConfig, 'fetchByIdSupported'>,
): string {
  const value = String(id);
  if (config.fetchByIdSupported === false && UUID_RE.test(value)) {
    return value.slice(0, SHORT_UUID_LENGTH);
  }
  return value;
}
