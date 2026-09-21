/**
 * Session kind — the marker that separates a real user session from a
 * machine-made one (#4159).
 *
 * Before this, the only signal that a session was machine-made was the
 * `observer-sessions` project value, so any internal session written under a
 * real project name looked exactly like user work in a session picker. `kind`
 * is an explicit column: every listing query keeps only `user` rows, so
 * internal and keepalive sessions drop out of pickers outright.
 *
 * - `user`      — a real user session. The default for every row.
 * - `internal`  — a machine session that must stay hidden from pickers but
 *                 still does its job (for example the observer's own SDK
 *                 sessions under `observer-sessions`).
 * - `keepalive` — a machine ping the host declares as a keepalive. Hidden from
 *                 pickers like `internal`, and additionally subject to the
 *                 keepalive off switch (`CLAUDE_MEM_KEEPALIVE_INTERVAL_MS`).
 */
export const SESSION_KIND_USER = 'user';
export const SESSION_KIND_INTERNAL = 'internal';
export const SESSION_KIND_KEEPALIVE = 'keepalive';

export type SessionKind =
  | typeof SESSION_KIND_USER
  | typeof SESSION_KIND_INTERNAL
  | typeof SESSION_KIND_KEEPALIVE;

const KNOWN_SESSION_KINDS: ReadonlySet<string> = new Set([
  SESSION_KIND_USER,
  SESSION_KIND_INTERNAL,
  SESSION_KIND_KEEPALIVE,
]);

/**
 * Normalize a caller-supplied kind to a known value. Anything absent or
 * unrecognized falls back to `user`, so a malformed field can never make a
 * real session vanish from a picker.
 */
export function normalizeSessionKind(raw: unknown): SessionKind {
  if (typeof raw === 'string') {
    const kind = raw.trim().toLowerCase();
    if (KNOWN_SESSION_KINDS.has(kind)) {
      return kind as SessionKind;
    }
  }
  return SESSION_KIND_USER;
}
