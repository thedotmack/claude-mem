/**
 * The internal projector secret gates /internal/v1/* and is compared against
 * a caller-controlled Authorization header, so the comparison must go through
 * crypto.subtle.timingSafeEqual, never a plain string equality.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasInternalCredential } from "../src/index";

const SECRET = "test-projector-secret";

function envWith(secret: string | undefined): Env {
	return { CMEM_INTERNAL_PROJECTOR_SECRET: secret } as unknown as Env;
}

function withAuthorization(value: string | null): Request {
	const headers: Record<string, string> = value === null ? {} : { Authorization: value };
	return new Request("https://sync-hub.test/internal/v1/sync/metadata", { headers });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hasInternalCredential", () => {
	it("accepts only the exact Bearer secret", async () => {
		expect(await hasInternalCredential(withAuthorization(`Bearer ${SECRET}`), envWith(SECRET))).toBe(true);
		// Same length as the real header, one character different.
		expect(await hasInternalCredential(withAuthorization(`Bearer ${SECRET.slice(0, -1)}x`), envWith(SECRET))).toBe(false);
		expect(await hasInternalCredential(withAuthorization(`Bearer ${SECRET}-longer`), envWith(SECRET))).toBe(false);
		expect(await hasInternalCredential(withAuthorization(SECRET), envWith(SECRET))).toBe(false);
		expect(await hasInternalCredential(withAuthorization(null), envWith(SECRET))).toBe(false);
	});

	it("refuses everything when no secret is configured", async () => {
		expect(await hasInternalCredential(withAuthorization("Bearer "), envWith(""))).toBe(false);
		expect(await hasInternalCredential(withAuthorization(`Bearer ${SECRET}`), envWith(undefined))).toBe(false);
	});

	it("decides through crypto.subtle.timingSafeEqual on equal-length digests", async () => {
		const timingSafeEqual = vi.spyOn(crypto.subtle, "timingSafeEqual");
		await hasInternalCredential(withAuthorization("Bearer short"), envWith(SECRET));
		expect(timingSafeEqual).toHaveBeenCalledTimes(1);
		const [provided, expected] = timingSafeEqual.mock.calls[0] as [ArrayBuffer, ArrayBuffer];
		expect(provided.byteLength).toBe(32);
		expect(expected.byteLength).toBe(32);
	});
});

describe("internal routes reject a near-miss secret", () => {
	const nearMiss = `Bearer ${SECRET.slice(0, -1)}x`;
	const routes = [
		"/internal/v1/projection/drain",
		"/internal/v1/sync/metadata",
		"/internal/v1/sync/device-name",
		"/internal/v1/sync/reset",
	];

	for (const route of routes) {
		it(`${route} answers 401`, async () => {
			const response = await SELF.fetch(`https://sync-hub.test${route}`, {
				method: "POST",
				headers: { Authorization: nearMiss, "Content-Type": "application/json" },
				body: JSON.stringify({ protocol_version: 1, user_id: "user" }),
			});
			expect(response.status).toBe(401);
		});
	}

	it("lets the right secret past auth on the drain route", async () => {
		const response = await SELF.fetch("https://sync-hub.test/internal/v1/projection/drain", {
			method: "POST",
			headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
			body: "not json",
		});
		expect(response.status).toBe(400);
	});
});
