/**
 * Adapter-layer rejection. Plan 05 Phase 6 (PATHFINDER-2026-04-22): cwd
 * validation moves from per-handler `if (!cwd) throw …` to the adapter
 * boundary. When normalization detects an invalid input, the adapter throws
 * `AdapterRejectedInput`; the hook runner translates it into a graceful
 * `{ continue: true }` so the user's session is never blocked by a malformed
 * hook payload.
 */

export class AdapterRejectedInput extends Error {
  constructor(public readonly reason: string) {
    super(`adapter rejected input: ${reason}`);
    this.name = 'AdapterRejectedInput';
  }
}

/**
 * A cwd is valid when it is a non-empty string. The adapter normalizers fall
 * back to `process.cwd()` when the inbound payload omits cwd, so the only way
 * this returns false is when the payload supplies `null`/`''`/non-string.
 */
export function isValidCwd(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0;
}
