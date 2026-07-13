/**
 * Numeric semver keying shared by every resolver that must pick the HIGHEST
 * installed version — never the newest-by-mtime. Sorting plugin/worker cache
 * directories by modification time manufactures a plugin<->worker version skew
 * (issue #3216) that drives the chroma-mcp orphan-leak recycle loop, so all such
 * resolvers route through this comparator instead of `ls -dt` / mtime sorts.
 */

/** Parse "13.10.4" or "2.1.176 (Claude Code)" → [13, 10, 4]; unparseable sorts lowest. */
export function parseVersionKey(version: string): [number, number, number] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Descending comparator over parsed keys: higher semver first. */
export function compareVersionKeysDesc(a: [number, number, number], b: [number, number, number]): number {
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}
