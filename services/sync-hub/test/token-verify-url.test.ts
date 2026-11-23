import { describe, expect, it } from "vitest";
import { authenticateRequest, type AuthDependencies } from "../src/index";

// The verify endpoint is the one outbound URL that receives the caller's
// bearer token. It must follow the same rule as the other deployment URLs:
// https, or http only for a loopback host, with no query, fragment or
// credentials. A malformed value is refused as a configuration fault.

const request = new Request("https://sync.cmem.ai/v1/sync/status", {
	headers: {
		Authorization: "Bearer token-for-user",
		"X-User-Id": "user-1",
		"X-Device-Id": "dev-verify-url",
	},
});

function envWith(tokenVerifyUrl: string): Env {
	return { TOKEN_VERIFY_URL: tokenVerifyUrl, AUTH_CACHE_TTL_SECONDS: "300" } as unknown as Env;
}

function dependencies(onVerify: (url: string) => void): AuthDependencies {
	return {
		async readCachedVerdict() {
			return null;
		},
		async cacheVerifiedVerdict() {},
		async invalidateCachedVerdict() {},
		async verifyToken(verifyRequest) {
			onVerify(verifyRequest.url);
			return Response.json({ userId: "user-1" });
		},
		logCacheFailure() {},
	};
}

describe("TOKEN_VERIFY_URL", () => {
	it.each([
		["plain http to a non-loopback host", "http://verify.example/api"],
		["embedded credentials", "https://user:pass@verify.example/api"],
		["a query string", "https://verify.example/api?token=1"],
		["a fragment", "https://verify.example/api#frag"],
		["an unparseable value", "not a url"],
		["a blank value", "   "],
	])("refuses %s without calling the verifier", async (_label, url) => {
		let calls = 0;
		const result = await authenticateRequest(
			request,
			envWith(url),
			dependencies(() => {
				calls += 1;
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable verifier authenticated");
		expect(result.response.status).toBe(503);
		expect(calls).toBe(0);
	});

	it("accepts https and loopback http, normalizing the trailing slash", async () => {
		for (const url of ["https://verify.example/api/", "http://127.0.0.1:8787/verify"]) {
			const seen: string[] = [];
			const result = await authenticateRequest(request, envWith(url), dependencies((seenUrl) => seen.push(seenUrl)));
			expect(result.ok).toBe(true);
			expect(seen).toEqual([url.replace(/\/+$/, "")]);
		}
	});
});