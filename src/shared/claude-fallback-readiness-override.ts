/**
 * The test override for claude-fallback-readiness, kept in a module with no
 * imports so tests/preload.ts can set it without loading settings, paths, or
 * credential code before any test file (and its module mocks) runs.
 */
let override: (() => boolean) | null = null;

export function getClaudeFallbackReadinessOverride(): (() => boolean) | null {
  return override;
}

/**
 * Replace the readiness check (null restores real detection). Returns the
 * previous override so a test can put it back.
 */
export function setClaudeFallbackReadinessForTesting(check: (() => boolean) | null): (() => boolean) | null {
  const previous = override;
  override = check;
  return previous;
}
