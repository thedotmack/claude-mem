/**
 * Shared positive-verdict cache TTL resolution. Lives outside index.ts so the
 * SyncHub Durable Object can bound WebSocket authorization by the same window
 * a revoked token could linger in the verdict cache — without importing the
 * worker entrypoint (which re-exports the DO, a circular dependency).
 */

export const AUTH_CACHE_TTL_MIN_SECONDS = 60;
export const AUTH_CACHE_TTL_MAX_SECONDS = 3_600;
/** Default positive-verdict TTL. Cuts KV rewrites vs the old 60s bound. */
export const AUTH_CACHE_TTL_DEFAULT_SECONDS = 900;

export function cacheTtlSeconds(env: { AUTH_CACHE_TTL_SECONDS?: string }): number {
	const parsed = parseBoundedPositiveInteger(env.AUTH_CACHE_TTL_SECONDS ?? "", AUTH_CACHE_TTL_MAX_SECONDS);
	if (parsed === null) return AUTH_CACHE_TTL_DEFAULT_SECONDS;
	return Math.min(
		AUTH_CACHE_TTL_MAX_SECONDS,
		Math.max(AUTH_CACHE_TTL_MIN_SECONDS, parsed),
	);
}

/** Parse only deliberately small control-plane integers, never uint64 data. */
function parseBoundedPositiveInteger(raw: string, maximum: number): number | null {
	if (!/^[1-9][0-9]*$/.test(raw)) return null;
	let value = 0;
	for (const digit of raw) {
		value = (value * 10) + (digit.charCodeAt(0) - 48);
		if (value > maximum) return maximum;
	}
	return value;
}
