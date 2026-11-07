/**
 * A `SessionStore.db` stand-in for test doubles that store observations but
 * hold no media. ResponseProcessor asks the database, on every storing turn,
 * whether a skipped turn of the same prompt left images waiting
 * (docs/media-contract-v1.md, "Capture-only linkage"); here nothing waits.
 */
export function sessionDbWithoutMedia() {
  return { prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0 }) }) };
}
