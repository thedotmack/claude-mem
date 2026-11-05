/**
 * Real token-verification path. Outbound fetches are served by the mock verify
 * endpoint defined in vitest.config.ts (see its token table).
 *
 * The load-bearing case is the user↔token binding: a 2xx from the verify
 * endpoint only proves the token is valid for SOMEONE — the Worker must
 * compare the response's canonical user id against the presented X-User-Id,
 * 403 on mismatch/missing, and never cache an unbound verdict. Otherwise any
 * valid subscriber could read/write any victim's log by forging X-User-Id.
 */

import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTH_CACHE_TTL_DEFAULT_SECONDS,
	AUTH_CACHE_TTL_MAX_SECONDS,
	AUTH_CACHE_TTL_MIN_SECONDS,
	__resetAuthVerdictMemoryForTests,
	authenticateRequest,
	defaultAuthDependencies,
	type AuthDependencies,
} from "../src/index";

const base = "https://sync.cmem.ai";

function headers(token: string, userId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"X-User-Id": userId,
		"X-Device-Id": "dev-auth",
	};
}

function getStatus(token: string, userId: string): Promise<Response> {
	return SELF.fetch(`${base}/v1/sync/status`, {
		headers: headers(token, userId),
	});
}

describe("token verification (real path)", () => {
	it("does not honor the removed legacy bypass on a production URL", async () => {
		// vitest.config.ts deliberately supplies DEV_ALLOW_ANY_TOKEN=true as an
		// unknown legacy binding. This still has to reach the mocked verifier.
		const res = await getStatus("legacy-bypass-regression", "user-auth-legacy");
		expect(res.status).toBe(401);
	});

	it("authorizes when verify returns the matching canonical userId", async () => {
		const res = await getStatus("valid-for:user-auth-1", "user-auth-1");
		expect(res.status).toBe(200);
	});

	it("accepts the snake_case user_id variant", async () => {
		const res = await getStatus("snake-for:user-auth-2", "user-auth-2");
		expect(res.status).toBe(200);
	});

	it("403s when the canonical user id does not match the presented X-User-Id, and never caches the forged pair", async () => {
		// The token is valid (2xx from verify) but belongs to someone-else:
		// impersonating a victim id must fail.
		const first = await getStatus("wrong-user", "victim-user");
		expect(first.status).toBe(403);
		const body = (await first.json()) as { error: string };
		expect(body.error).toContain("does not belong");

		// Regression guard for the cache: were the forged pair cached as a
		// positive verdict, this second identical request would return 200.
		const second = await getStatus("wrong-user", "victim-user");
		expect(second.status).toBe(403);
	});

	it("403s when verify omits the canonical user id", async () => {
		const res = await getStatus("no-id", "user-auth-3");
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("missing canonical user id");
	});

	it("401s when verify rejects the token (401)", async () => {
		const res = await getStatus("denied-401", "user-auth-4");
		expect(res.status).toBe(401);
	});

	it("401s when verify rejects the token (403)", async () => {
		const res = await getStatus("denied-403", "user-auth-5");
		expect(res.status).toBe(401);
	});

	it("passes a lapsed subscription through as 403 subscription_inactive (402)", async () => {
		// The Pro verifier answers 402 for a lapsed, cancelled or unpaid plan.
		// That is an entitlement decision, not an outage: the Hub must answer it
		// terminally so the client pauses sync with the "renew at cmem.ai/pro"
		// message instead of retrying a 503 forever.
		const res = await getStatus("denied-402", "user-auth-402");
		expect(res.status).toBe(403);
		const body = await res.json() as Record<string, unknown>;
		expect(body.code).toBe("subscription_inactive");
	});

	it("503s fail-closed when the verify endpoint is unreachable", async () => {
		const res = await getStatus("network-error", "user-auth-6");
		expect(res.status).toBe(503);
	});

	it("503s fail-closed when the verify endpoint 500s", async () => {
		const res = await getStatus("upstream-500", "user-auth-7");
		expect(res.status).toBe(503);
	});

	it("caches positive verdicts in KV — the second request makes no second verify fetch", async () => {
		// The once-token answers 200 exactly once, then 500s. A second
		// authorized request can therefore only succeed via the KV cache.
		const token = "once-for:user-auth-cache:n1";
		const first = await getStatus(token, "user-auth-cache");
		expect(first.status).toBe(200);

		const second = await getStatus(token, "user-auth-cache");
		expect(second.status).toBe(200);
	});

	it("same user with a different token is a cache miss (verdicts are keyed per token)", async () => {
		// Prime the cache for this user with token A.
		const primed = await getStatus("once-for:user-auth-keyed:n2", "user-auth-keyed");
		expect(primed.status).toBe(200);

		// Token B for the SAME user maps to a mismatched canonical id at the
		// verify endpoint. A cache wrongly keyed by user alone would skip
		// verification and answer 200; the 403 proves the verify branch ran.
		const other = await getStatus("wrong-user", "user-auth-keyed");
		expect(other.status).toBe(403);
	});
});

function unusedInvalidate(): Pick<AuthDependencies, "invalidateCachedVerdict"> {
	return {
		async invalidateCachedVerdict() {},
	};
}

describe("token-verdict cache behavior", () => {
	const userId = "user-auth-cache-failure";
	const token = `valid-for:${userId}`;
	const request = new Request(`${base}/v1/sync/status`, {
		headers: headers(token, userId),
	});
	const authEnv = {
		TOKEN_VERIFY_URL: "https://cmem.ai/api/pro/sync/verify",
		AUTH_CACHE_TTL_SECONDS: "300",
		// Deliberately supplied as a legacy unknown binding. Production auth must
		// ignore it even in direct tests.
		DEV_ALLOW_ANY_TOKEN: "true",
	} as unknown as Env;

	it("treats a cache get failure as a miss and verifies upstream", async () => {
		const logged: string[] = [];
		let verifyCalls = 0;
		let putCalls = 0;
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				throw new Error("simulated KV read outage");
			},
			async cacheVerifiedVerdict() {
				putCalls += 1;
			},
			...unusedInvalidate(),
			async verifyToken(verifyRequest) {
				verifyCalls += 1;
				expect(verifyRequest.url).toBe(authEnv.TOKEN_VERIFY_URL);
				return Response.json({ userId });
			},
			logCacheFailure(operation) {
				logged.push(operation);
			},
		};

		const result = await authenticateRequest(request, authEnv, dependencies);
		expect(result).toEqual({
			ok: true,
			userId,
			deviceId: "dev-auth",
			deviceName: null,
			authExpiresAtMs: expect.any(Number),
		});
		expect(verifyCalls).toBe(1);
		expect(putCalls).toBe(1);
		expect(logged).toEqual(["get"]);
	});

	it("logs a cache put failure but preserves verified success", async () => {
		const logged: string[] = [];
		let verifyCalls = 0;
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return null;
			},
			async cacheVerifiedVerdict() {
				throw new Error("simulated KV write outage");
			},
			...unusedInvalidate(),
			async verifyToken() {
				verifyCalls += 1;
				return Response.json({ userId });
			},
			logCacheFailure(operation) {
				logged.push(operation);
			},
		};

		const result = await authenticateRequest(request, authEnv, dependencies);
		expect(result).toEqual({
			ok: true,
			userId,
			deviceId: "dev-auth",
			deviceName: null,
			authExpiresAtMs: expect.any(Number),
		});
		expect(verifyCalls).toBe(1);
		expect(logged).toEqual(["put"]);
	});

	it("honors AUTH_CACHE_TTL_SECONDS and re-verifies a revoked token at the boundary", async () => {
		let nowMs = 0;
		let cachedUntilMs = 0;
		let verifyCalls = 0;
		let revoked = false;
		const ttlWrites: number[] = [];
		const invalidated: string[] = [];
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return nowMs < cachedUntilMs
					? String(Date.now() + (cachedUntilMs - nowMs))
					: null;
			},
			async cacheVerifiedVerdict(_cacheKey, ttlSeconds) {
				ttlWrites.push(ttlSeconds);
				cachedUntilMs = nowMs + ttlSeconds * 1_000;
			},
			async invalidateCachedVerdict(cacheKey) {
				invalidated.push(cacheKey);
				cachedUntilMs = 0;
			},
			async verifyToken() {
				verifyCalls += 1;
				return revoked
					? Response.json({ error: "rotated" }, { status: 401 })
					: Response.json({ userId });
			},
			logCacheFailure() {},
		};

		expect(await authenticateRequest(request, authEnv, dependencies)).toEqual({
			ok: true,
			userId,
			deviceId: "dev-auth",
			deviceName: null,
			authExpiresAtMs: expect.any(Number),
		});
		expect(ttlWrites).toEqual([300]);
		revoked = true;

		nowMs = 299_999;
		expect((await authenticateRequest(request, authEnv, dependencies)).ok).toBe(true);
		expect(verifyCalls).toBe(1);

		nowMs = 300_000;
		const rejected = await authenticateRequest(request, authEnv, dependencies);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("rotated token unexpectedly authenticated");
		expect(rejected.response.status).toBe(401);
		expect(verifyCalls).toBe(2);
		expect(invalidated).toHaveLength(1);
	});

	it("cannot extend entitlement expiry beyond the configured TTL", async () => {
		let nowMs = 0;
		const entitlementExpiresAtMs = 1_000;
		let cachedUntilMs = 0;
		let verifyCalls = 0;
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return nowMs < cachedUntilMs
					? String(Date.now() + (cachedUntilMs - nowMs))
					: null;
			},
			async cacheVerifiedVerdict(_cacheKey, ttlSeconds) {
				expect(ttlSeconds).toBeLessThanOrEqual(AUTH_CACHE_TTL_MAX_SECONDS);
				expect(ttlSeconds).toBe(300);
				cachedUntilMs = nowMs + ttlSeconds * 1_000;
			},
			...unusedInvalidate(),
			async verifyToken() {
				verifyCalls += 1;
				return nowMs < entitlementExpiresAtMs
					? Response.json({ userId })
					: Response.json({ error: "expired" }, { status: 401 });
			},
			logCacheFailure() {},
		};

		expect((await authenticateRequest(request, authEnv, dependencies)).ok).toBe(true);
		nowMs = 299_999;
		expect((await authenticateRequest(request, authEnv, dependencies)).ok).toBe(true);
		expect(verifyCalls).toBe(1);

		nowMs = 300_000;
		const rejected = await authenticateRequest(request, authEnv, dependencies);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("expired entitlement unexpectedly authenticated");
		expect(rejected.response.status).toBe(401);
		expect(nowMs - entitlementExpiresAtMs).toBeLessThanOrEqual(300_000);
		expect(verifyCalls).toBe(2);
	});

	it("defaults TTL to 15 minutes and clamps to 60s–60m", async () => {
		const ttlWrites: number[] = [];
		const captureTtl = (env: Env): AuthDependencies => ({
			async readCachedVerdict() {
				return null;
			},
			async cacheVerifiedVerdict(_cacheKey, ttlSeconds) {
				ttlWrites.push(ttlSeconds);
			},
			...unusedInvalidate(),
			async verifyToken() {
				return Response.json({ userId });
			},
			logCacheFailure() {},
		});

		await authenticateRequest(
			request,
			{ ...authEnv, AUTH_CACHE_TTL_SECONDS: "" } as Env,
			captureTtl(authEnv),
		);
		await authenticateRequest(
			request,
			{ ...authEnv, AUTH_CACHE_TTL_SECONDS: "30" } as Env,
			captureTtl(authEnv),
		);
		await authenticateRequest(
			request,
			{ ...authEnv, AUTH_CACHE_TTL_SECONDS: "7200" } as Env,
			captureTtl(authEnv),
		);
		expect(ttlWrites).toEqual([
			AUTH_CACHE_TTL_DEFAULT_SECONDS,
			AUTH_CACHE_TTL_MIN_SECONDS,
			AUTH_CACHE_TTL_MAX_SECONDS,
		]);
	});

	it("invalidates the cached verdict when verify rejects the token", async () => {
		const invalidated: string[] = [];
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return null;
			},
			async cacheVerifiedVerdict() {},
			async invalidateCachedVerdict(cacheKey) {
				invalidated.push(cacheKey);
			},
			async verifyToken() {
				return Response.json({ error: "revoked" }, { status: 401 });
			},
			logCacheFailure() {},
		};

		const rejected = await authenticateRequest(request, authEnv, dependencies);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("revoked token unexpectedly authenticated");
		expect(rejected.response.status).toBe(401);
		expect(invalidated).toHaveLength(1);
		expect(invalidated[0]).toMatch(/^verdict:[0-9a-f]{64}$/);
	});

	it("invalidates the cached verdict and answers 403 when verify reports an inactive subscription (402)", async () => {
		// Without this, a lapsed subscriber's positive verdict stays in KV for the
		// whole AUTH_CACHE_TTL window (default 15m, max 60m) and the client only
		// sees a retryable 503, so it never reaches the "renew your plan" state.
		const invalidated: string[] = [];
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return null;
			},
			async cacheVerifiedVerdict() {},
			async invalidateCachedVerdict(cacheKey) {
				invalidated.push(cacheKey);
			},
			async verifyToken() {
				return Response.json(
					{ error: "Subscription not active", code: "subscription_inactive", status: "past_due" },
					{ status: 402 },
				);
			},
			logCacheFailure() {},
		};

		const rejected = await authenticateRequest(request, authEnv, dependencies);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("lapsed subscription unexpectedly authenticated");
		expect(rejected.response.status).toBe(403);
		expect(await rejected.response.json()).toMatchObject({ code: "subscription_inactive" });
		expect(invalidated).toHaveLength(1);
	});
});

describe("token-verdict isolate memory (default KV adapter)", () => {
	const userId = "user-auth-memory";
	const token = `valid-for:${userId}`;
	const request = new Request(`${base}/v1/sync/status`, {
		headers: headers(token, userId),
	});

	afterEach(() => {
		__resetAuthVerdictMemoryForTests();
	});

	function fakeKvEnv(): {
		env: Env;
		gets: number;
		puts: number;
		deletes: number;
	} {
		const store = new Map<string, string>();
		let gets = 0;
		let puts = 0;
		let deletes = 0;
		const env = {
			TOKEN_VERIFY_URL: "https://cmem.ai/api/pro/sync/verify",
			AUTH_CACHE_TTL_SECONDS: "900",
			AUTH_CACHE: {
				async get(key: string) {
					gets += 1;
					return store.get(key) ?? null;
				},
				async put(key: string, value: string) {
					puts += 1;
					store.set(key, value);
				},
				async delete(key: string) {
					deletes += 1;
					store.delete(key);
				},
			},
		} as unknown as Env;
		return {
			env,
			get gets() {
				return gets;
			},
			get puts() {
				return puts;
			},
			get deletes() {
				return deletes;
			},
		};
	}

	it("does not rewrite KV when isolate memory can still serve the verdict", async () => {
		const kv = fakeKvEnv();
		const dependencies = defaultAuthDependencies(kv.env);
		let verifyCalls = 0;
		const wrapped: AuthDependencies = {
			readCachedVerdict: (cacheKey) => dependencies.readCachedVerdict(cacheKey),
			cacheVerifiedVerdict: (cacheKey, ttlSeconds) =>
				dependencies.cacheVerifiedVerdict(cacheKey, ttlSeconds),
			invalidateCachedVerdict: (cacheKey) => dependencies.invalidateCachedVerdict(cacheKey),
			async verifyToken() {
				verifyCalls += 1;
				return Response.json({ userId });
			},
			logCacheFailure() {},
		};

		expect((await authenticateRequest(request, kv.env, wrapped)).ok).toBe(true);
		expect((await authenticateRequest(request, kv.env, wrapped)).ok).toBe(true);
		expect(verifyCalls).toBe(1);
		expect(kv.puts).toBe(1);
		expect(kv.gets).toBe(1);
	});

	it("skips a second KV put when a concurrent miss already populated memory", async () => {
		const kv = fakeKvEnv();
		const dependencies = defaultAuthDependencies(kv.env);
		await dependencies.cacheVerifiedVerdict("verdict:demo", AUTH_CACHE_TTL_DEFAULT_SECONDS);
		await dependencies.cacheVerifiedVerdict("verdict:demo", AUTH_CACHE_TTL_DEFAULT_SECONDS);
		expect(kv.puts).toBe(1);
		// A memory hit answers with the verdict's own expiry, so a caller can
		// bound a socket by it without a fresh TTL.
		const memoExpiry = await dependencies.readCachedVerdict("verdict:demo");
		expect(Number(memoExpiry)).toBeGreaterThan(Date.now());
		expect(kv.gets).toBe(0);
	});

	it("deletes the KV entry on invalidate", async () => {
		const kv = fakeKvEnv();
		const dependencies = defaultAuthDependencies(kv.env);
		await dependencies.cacheVerifiedVerdict("verdict:demo", AUTH_CACHE_TTL_DEFAULT_SECONDS);
		await dependencies.invalidateCachedVerdict("verdict:demo");
		expect(kv.deletes).toBe(1);
		expect(await dependencies.readCachedVerdict("verdict:demo")).toBeNull();
	});

	it("stores the verdict's own expiry in KV and reads it back after memory is lost", async () => {
		const kv = fakeKvEnv();
		const dependencies = defaultAuthDependencies(kv.env);
		await dependencies.cacheVerifiedVerdict("verdict:expiry", 300);
		const stored = await kv.env.AUTH_CACHE.get("verdict:expiry");
		expect(Number(stored)).toBeGreaterThan(Date.now());

		// A different isolate has no memo, so the KV hit must carry the deadline.
		__resetAuthVerdictMemoryForTests();
		expect(await dependencies.readCachedVerdict("verdict:expiry")).toBe(String(Number(stored)));
	});

	it("keeps a KV verdict's own expiry when the short re-read memo serves it", async () => {
		const kv = fakeKvEnv();
		const dependencies = defaultAuthDependencies(kv.env);
		const verdictExpiryMs = Date.now() + 300_000;
		await kv.env.AUTH_CACHE.put("verdict:long", String(verdictExpiryMs));

		// The first read comes from KV, the second from the 60s memo; both must
		// hand back the verdict's expiry, never the memo's shorter refresh point.
		expect(await dependencies.readCachedVerdict("verdict:long")).toBe(String(verdictExpiryMs));
		expect(await dependencies.readCachedVerdict("verdict:long")).toBe(String(verdictExpiryMs));
	});

	it("drops a legacy unversioned verdict instead of trusting it without an expiry", async () => {
		const kv = fakeKvEnv();
		const dependencies = defaultAuthDependencies(kv.env);
		await kv.env.AUTH_CACHE.put("verdict:legacy", "1");
		expect(await dependencies.readCachedVerdict("verdict:legacy")).toBeNull();
		expect(await kv.env.AUTH_CACHE.get("verdict:legacy")).toBeNull();
	});
});

/**
 * The advisory socket outlives the HTTP request that opened it, so the upgrade
 * needs a deadline that comes from the verdict which authorized it. A fresh
 * verdict uses the TTL that was just cached; a cached one uses the cache
 * entry's own expiry, so a socket can never outlive the verdict it rides on.
 */
describe("socket auth deadline", () => {
	const userId = "user-auth-deadline";
	const request = new Request(`${base}/v1/sync/status`, {
		headers: headers(`valid-for:${userId}`, userId),
	});
	const authEnv = {
		TOKEN_VERIFY_URL: "https://cmem.ai/api/pro/sync/verify",
		AUTH_CACHE_TTL_SECONDS: "300",
	} as unknown as Env;

	it("brand-new verdict: the deadline is the TTL that was just cached", async () => {
		let cachedTtl = 0;
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return null;
			},
			async cacheVerifiedVerdict(_cacheKey, ttlSeconds) {
				cachedTtl = ttlSeconds;
			},
			...unusedInvalidate(),
			async verifyToken() {
				return Response.json({ userId });
			},
			logCacheFailure() {},
		};

		const before = Date.now();
		const result = await authenticateRequest(request, authEnv, dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(cachedTtl).toBe(300);
		expect(result.authExpiresAtMs).toBeGreaterThanOrEqual(before + 300_000);
		expect(result.authExpiresAtMs).toBeLessThanOrEqual(Date.now() + 300_000);
	});

	it("cached verdict: the deadline is the cache entry's own expiry, not a fresh TTL", async () => {
		const cachedExpiry = Date.now() + 1_000;
		let verifyCalls = 0;
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return String(cachedExpiry);
			},
			async cacheVerifiedVerdict() {},
			...unusedInvalidate(),
			async verifyToken() {
				verifyCalls += 1;
				return Response.json({ userId });
			},
			logCacheFailure() {},
		};

		const result = await authenticateRequest(request, authEnv, dependencies);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.authExpiresAtMs).toBe(cachedExpiry);
		expect(verifyCalls).toBe(0);
	});
});
