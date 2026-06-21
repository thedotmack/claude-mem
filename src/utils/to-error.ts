/**
 * Normalize an unknown thrown value to an Error. Catch clauses receive
 * `unknown`; a thrown non-Error (string, number, rejected non-Error) becomes
 * `new Error(String(value))`. Replaces the repeated
 * `e instanceof Error ? e : new Error(String(e))` ternary.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
