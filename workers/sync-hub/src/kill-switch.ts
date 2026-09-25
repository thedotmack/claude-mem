/**
 * Kill switch — the structural cost guardrail (plan Phase 5 task 2).
 *
 * One KV flag. Tripped ⇒ the front Worker refuses WebSocket upgrades (503 +
 * a JSON body clients recognize) and stamps `X-Sync-Mode: poll` on every HTTP
 * sync response. That un-pins idle Durable Objects; it must not skip the
 * push-path projection drain. Clients require `head_seq <= projected_seq` on
 * every 200, so poll mode still drains on an active push (one bounded
 * inline pass) and still exposes `/internal/v1/projection/drain`.
 * Extra getProjectionState / heartbeatProjectionLease RPCs stay gone — those
 * were automated DO storage knocks with no fencing value. The product stays
 * COMPLETE in poll mode (~$0.03/user/mo indefinitely) — the switch degrades
 * socket latency, never correctness (prime directive #5: watchdog → poll
 * mode, never "stop working").
 *
 * STORAGE CHOICE — reuse AUTH_CACHE with a distinct `control:` key, not a
 * dedicated SYNC_CONTROL namespace. Rationale: (a) AUTH_CACHE is already a
 * hard dependency of every environment (prod, wrangler dev, vitest), so the
 * switch works everywhere with zero extra provisioning — a missing namespace
 * binding fails the WHOLE deploy, which is exactly the wrong failure mode
 * for an emergency brake; (b) blast radius is contained by key prefix: auth
 * verdicts live under `verdict:<sha256>` with a TTL, the switch under
 * `control:` with no TTL, and nothing enumerates keys; (c) the dedicated
 * namespace's only advantage (separate ACLs/wipe) is moot — both are
 * operated by the same maintainer with the same wrangler token. Documented
 * in DEPLOY.md alongside the trip/clear commands.
 *
 * READ CACHING — per-isolate, KILL_SWITCH_CACHE_MS (default 30 s). KV reads
 * are cheap ($0.50/M) and edge-cached (~60 s propagation anyway), but the
 * front Worker sits on EVERY sync request, so a per-request read would buy
 * nothing: KV's own propagation delay dominates freshness either way. 30 s
 * of isolate cache adds at most 30 s to an already-≈60 s trip/clear
 * propagation and drops KV read volume by orders of magnitude. Tests and
 * local e2e set KILL_SWITCH_CACHE_MS=0 for per-request reads.
 *
 * FAIL-CLOSED — a KV read error counts as tripped when this isolate has no
 * last-known value. The switch is the cost brake: a Workers KV daily-read-cap
 * throw (or any other get failure) must not silently disable it. A warm
 * isolate keeps serving the last successful read; a cold isolate with a
 * failing get defaults ON (same tripped behavior as a present key).
 */

/** The KV key (in AUTH_CACHE) holding the kill-switch flag. */
export const KILL_SWITCH_KEY = "control:kill-switch";

/** Header stamped on HTTP sync responses while the switch is tripped. */
export const SYNC_MODE_HEADER = "X-Sync-Mode";
export const SYNC_MODE_POLL = "poll";

const DEFAULT_CACHE_MS = 30_000;

export interface KillSwitchState {
	tripped: boolean;
	/** Raw KV value (JSON string written by tripKillSwitch, or manual). */
	raw: string | null;
}

interface CacheEntry {
	state: KillSwitchState;
	fetchedAt: number;
}

/** Per-isolate cache. Module-level on purpose — isolates are the cache unit. */
let cache: CacheEntry | null = null;

/** Latch so a KV outage logs once per isolate, not on every request. */
let kvReadFailureLogged = false;

/** Tests only: forget the per-isolate cache and the fail-closed log latch. */
export function __resetKillSwitchCacheForTests(): void {
	cache = null;
	kvReadFailureLogged = false;
}

export function killSwitchCacheMs(env: Env): number {
	const parsed = Number.parseInt(env.KILL_SWITCH_CACHE_MS ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CACHE_MS;
	return parsed;
}

/**
 * Read the kill-switch state, through the per-isolate cache. ANY non-null
 * value at the key means tripped — presence is the contract, the JSON
 * content is operator information only (so a hand-typed
 * `wrangler kv key put ... "1"` works in an emergency).
 */
export async function readKillSwitch(
	env: Env,
	options: { now?: () => number } = {},
): Promise<KillSwitchState> {
	const now = options.now ?? Date.now;
	const ttl = killSwitchCacheMs(env);
	if (cache !== null && ttl > 0 && now() - cache.fetchedAt < ttl) {
		return cache.state;
	}
	let raw: string | null = null;
	try {
		raw = await env.AUTH_CACHE.get(KILL_SWITCH_KEY);
	} catch (e) {
		// Fail-closed (see module header). Keep the last successful read when
		// we have one; otherwise treat the switch as ON. Never cache the
		// failure, so a recovered get is visible on the next uncached read.
		if (!kvReadFailureLogged) {
			kvReadFailureLogged = true;
			console.error("kill-switch KV read failed (failing closed):", e);
		}
		if (cache !== null) {
			return cache.state;
		}
		return { tripped: true, raw: null };
	}
	const state: KillSwitchState = { tripped: raw !== null, raw };
	cache = { state, fetchedAt: now() };
	return state;
}

/**
 * Trip the switch (watchdog escalation, or callable from a maintenance
 * script). No TTL — the switch stays tripped until a human clears it
 * (auto-clear would flap: the metrics that tripped it go quiet BECAUSE the
 * switch is doing its job). Returns false when the flag already existed.
 */
export async function tripKillSwitch(
	env: Env,
	reason: Record<string, unknown>,
): Promise<{ alreadyTripped: boolean }> {
	const existing = await env.AUTH_CACHE.get(KILL_SWITCH_KEY);
	if (existing !== null) return { alreadyTripped: true };
	await env.AUTH_CACHE.put(
		KILL_SWITCH_KEY,
		JSON.stringify({ tripped_at: new Date().toISOString(), ...reason }),
	);
	return { alreadyTripped: false };
}
