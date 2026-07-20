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
import { describe, expect, it } from "vitest";
import {
	authenticateRequest,
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
		expect(result).toEqual({ ok: true, userId, deviceId: "dev-auth", deviceName: null });
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
			async verifyToken() {
				verifyCalls += 1;
				return Response.json({ userId });
			},
			logCacheFailure(operation) {
				logged.push(operation);
			},
		};

		const result = await authenticateRequest(request, authEnv, dependencies);
		expect(result).toEqual({ ok: true, userId, deviceId: "dev-auth", deviceName: null });
		expect(verifyCalls).toBe(1);
		expect(logged).toEqual(["put"]);
	});

	it("caps positive verdicts at 60s and re-verifies at the boundary", async () => {
		let nowMs = 0;
		let cachedUntilMs = 0;
		let verifyCalls = 0;
		let revoked = false;
		const ttlWrites: number[] = [];
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return nowMs < cachedUntilMs ? "1" : null;
			},
			async cacheVerifiedVerdict(_cacheKey, ttlSeconds) {
				ttlWrites.push(ttlSeconds);
				cachedUntilMs = nowMs + ttlSeconds * 1_000;
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
		});
		expect(ttlWrites).toEqual([60]);
		revoked = true;

		nowMs = 59_999;
		expect((await authenticateRequest(request, authEnv, dependencies)).ok).toBe(true);
		expect(verifyCalls).toBe(1);

		nowMs = 60_000;
		const rejected = await authenticateRequest(request, authEnv, dependencies);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("rotated token unexpectedly authenticated");
		expect(rejected.response.status).toBe(401);
		expect(verifyCalls).toBe(2);
	});

	it("cannot extend entitlement expiry beyond the 60s composed bound", async () => {
		let nowMs = 0;
		const entitlementExpiresAtMs = 1_000;
		let cachedUntilMs = 0;
		let verifyCalls = 0;
		const dependencies: AuthDependencies = {
			async readCachedVerdict() {
				return nowMs < cachedUntilMs ? "1" : null;
			},
			async cacheVerifiedVerdict(_cacheKey, ttlSeconds) {
				expect(ttlSeconds).toBeLessThanOrEqual(60);
				cachedUntilMs = nowMs + ttlSeconds * 1_000;
			},
			async verifyToken() {
				verifyCalls += 1;
				return nowMs < entitlementExpiresAtMs
					? Response.json({ userId })
					: Response.json({ error: "expired" }, { status: 401 });
			},
			logCacheFailure() {},
		};

		expect((await authenticateRequest(request, authEnv, dependencies)).ok).toBe(true);
		nowMs = 59_999;
		expect((await authenticateRequest(request, authEnv, dependencies)).ok).toBe(true);
		expect(verifyCalls).toBe(1);

		nowMs = 60_000;
		const rejected = await authenticateRequest(request, authEnv, dependencies);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) throw new Error("expired entitlement unexpectedly authenticated");
		expect(rejected.response.status).toBe(401);
		expect(nowMs - entitlementExpiresAtMs).toBeLessThanOrEqual(60_000);
		expect(verifyCalls).toBe(2);
	});
});
