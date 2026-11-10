import { afterAll, describe, expect, it } from "bun:test";
import {
	authenticateRequest,
	defaultAuthDependencies,
	cacheTtlSeconds,
	__resetAuthVerdictMemoryForTests,
	type AuthDependencies,
} from "../src/auth";
import type { SyncApiEnv } from "../src/env";
import { authHeaders, trackedApp, uniqueUser, stopTrackedApps } from "./helpers";

afterAll(stopTrackedApps);

const env = {
	TOKEN_VERIFY_URL: "https://cmem.ai/api/pro/sync/verify",
	AUTH_CACHE_TTL_SECONDS: "300",
} as SyncApiEnv;

function unusedInvalidate(): Pick<AuthDependencies, "invalidateCachedVerdict"> {
	return { async invalidateCachedVerdict() {} };
}

describe("authenticateRequest", () => {
	function rejectingDeps(make: () => Response): AuthDependencies {
		return {
			async readCachedVerdict() { return null; },
			async cacheVerifiedVerdict() {},
			...unusedInvalidate(),
			async verifyToken() { return make(); },
			logCacheFailure() {},
		};
	}

	function authedRequest(): Request {
		return new Request("http://127.0.0.1/v1/sync/ops", {
			headers: { Authorization: "Bearer tok", "X-User-Id": "u" },
		});
	}

	it("passes a lapsed subscription through as 403 subscription_inactive", async () => {
		__resetAuthVerdictMemoryForTests();
		const result = await authenticateRequest(authedRequest(), env, rejectingDeps(() => Response.json(
			{ error: "Subscription not active", code: "subscription_inactive", status: "past_due" },
			{ status: 403 },
		)));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.status).toBe(403);
			const body = await result.response.json() as Record<string, unknown>;
			expect(body.code).toBe("subscription_inactive");
			expect(body.status).toBe("past_due");
			expect(String(body.message)).toContain("cmem.ai/pro");
		}
	});

	it("maps a legacy Pro 401 'Subscription not active' body to subscription_inactive", async () => {
		__resetAuthVerdictMemoryForTests();
		const result = await authenticateRequest(authedRequest(), env, rejectingDeps(() => Response.json(
			{ error: "Subscription not active" }, { status: 401 },
		)));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.status).toBe(403);
			expect((await result.response.json() as { code: string }).code).toBe("subscription_inactive");
		}
	});

	it("keeps a bad token as 401 invalid_token with a reconnect message", async () => {
		__resetAuthVerdictMemoryForTests();
		const result = await authenticateRequest(authedRequest(), env, rejectingDeps(() => Response.json(
			{ error: "Invalid token or user mismatch", code: "invalid_token" }, { status: 401 },
		)));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.status).toBe(401);
			const body = await result.response.json() as Record<string, unknown>;
			expect(body.code).toBe("invalid_token");
			expect(body.error).toBe("invalid token");
			expect(String(body.message)).toContain("Reconnect");
		}
	});

	it("401s without a bearer token or user id", async () => {
		const missingToken = await authenticateRequest(new Request("http://127.0.0.1/v1/sync/status", {
			headers: { "X-User-Id": "u" },
		}), env);
		expect(missingToken.ok).toBe(false);
		if (!missingToken.ok) expect(missingToken.response.status).toBe(401);

		const missingUser = await authenticateRequest(new Request("http://127.0.0.1/v1/sync/status", {
			headers: { Authorization: "Bearer tok" },
		}), env);
		expect(missingUser.ok).toBe(false);
		if (!missingUser.ok) expect(missingUser.response.status).toBe(401);
	});

	it("caches a positive verdict and skips the second verify", async () => {
		__resetAuthVerdictMemoryForTests();
		let verifyCalls = 0;
		const dependencies: AuthDependencies = {
			...defaultAuthDependencies(env),
			async verifyToken() {
				verifyCalls += 1;
				return Response.json({ userId: "alice" });
			},
		};
		const request = new Request("http://127.0.0.1/v1/sync/status", {
			headers: { Authorization: "Bearer tok", "X-User-Id": "alice", "X-Device-Id": "dev" },
		});
		const first = await authenticateRequest(request, env, dependencies);
		expect(first.ok).toBe(true);
		const second = await authenticateRequest(request, env, dependencies);
		expect(second.ok).toBe(true);
		expect(verifyCalls).toBe(1);
	});

	it("clamps AUTH_CACHE_TTL to the documented bounds", () => {
		expect(["1", "99999999999999999999", "abc"].map((AUTH_CACHE_TTL_SECONDS) =>
			cacheTtlSeconds({ ...env, AUTH_CACHE_TTL_SECONDS }))).toEqual([60, 3600, 900]);
	});
});

describe("HTTP auth", () => {
	it("authorizes matching tokens and rejects forged user ids", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const ok = await fetch(`${app.url}/v1/sync/status`, {
			headers: authHeaders(userId),
		});
		expect(ok.status).toBe(200);

		const forged = await fetch(`${app.url}/v1/sync/status`, {
			headers: authHeaders(userId, undefined, "wrong-user"),
		});
		expect(forged.status).toBe(403);

		const denied = await fetch(`${app.url}/v1/sync/status`, {
			headers: authHeaders(userId, undefined, "denied"),
		});
		expect(denied.status).toBe(401);
	});
});
