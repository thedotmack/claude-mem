/**
 * The one "is this a refused connection?" check behind every worker-down
 * decision (HealthMonitor shutdown, installer shutdown, `npx claude-mem search`,
 * the OpenCode plugin).
 *
 * A refused connection surfaces differently per runtime, and a
 * `message.includes('ECONNREFUSED')` check misses most of them:
 * - Bun's fetch rejects with `code: 'ConnectionRefused'` and an
 *   "Unable to connect…" message that never mentions ECONNREFUSED.
 * - Node's undici rejects with `TypeError('fetch failed')`; the ECONNREFUSED
 *   code lives only on `error.cause`, and with happy-eyeballs on a nested
 *   AggregateError's `errors`.
 * - Some wrappers keep only Node's message text ("connect ECONNREFUSED …").
 *
 * No imports on purpose: this module is bundled into the hooks and the
 * OpenCode plugin.
 */

const CONNECTION_REFUSED_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ConnectionRefused']);

function hasConnectionRefusedCode(error: unknown, seen: Set<unknown>): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.code === 'string' && CONNECTION_REFUSED_CODES.has(candidate.code)) return true;
  if (hasConnectionRefusedCode(candidate.cause, seen)) return true;
  return Array.isArray(candidate.errors)
    && candidate.errors.some((nested) => hasConnectionRefusedCode(nested, seen));
}

/**
 * True when `error` (or anything on its `cause` / `errors` chain) is a refused
 * connection. Bun's "Unable to connect" text WITHOUT the ConnectionRefused code
 * is deliberately not a match: the same message covers other socket failures.
 */
export function isConnectionRefusedError(error: unknown): boolean {
  if (hasConnectionRefusedCode(error, new Set())) return true;
  return error instanceof Error && error.message.includes('ECONNREFUSED');
}
