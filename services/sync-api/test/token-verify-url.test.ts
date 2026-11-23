import { describe, expect, it } from "bun:test";
import { loadEnv } from "../src/env";

// Every sync request sends `Authorization: Bearer <user token>` to this URL.
// FORWARD_ORIGIN and INTERNAL_PROJECTOR_URL are validated (https, or loopback
// http, no credentials/query/fragment); this URL was only trimmed, so a copied
// `http://` address sent user tokens in cleartext to whatever host it named.
// Forward mode keeps DATABASE_URL optional, so every case uses it.

const forward = { FORWARD_ORIGIN: "https://example.com" };

describe("TOKEN_VERIFY_URL", () => {
	it("falls back to the production endpoint when unset or blank", () => {
		expect(loadEnv(forward).TOKEN_VERIFY_URL).toBe("https://cmem.ai/api/pro/sync/verify");
		expect(loadEnv({ ...forward, TOKEN_VERIFY_URL: "   " }).TOKEN_VERIFY_URL).toBe("https://cmem.ai/api/pro/sync/verify");
	});

	it("accepts an https endpoint and normalizes its trailing slash", () => {
		expect(loadEnv({ ...forward, TOKEN_VERIFY_URL: "https://cmem.ai/api/pro/sync/verify/" }).TOKEN_VERIFY_URL)
			.toBe("https://cmem.ai/api/pro/sync/verify");
	});

	it("accepts http only for a loopback host", () => {
		for (const loopback of ["http://127.0.0.1:8787/verify", "http://localhost:8787/verify", "http://[::1]:8787/verify"]) {
			expect(loadEnv({ ...forward, TOKEN_VERIFY_URL: loopback }).TOKEN_VERIFY_URL).toBe(loopback);
		}
	});

	it("rejects plain http to a non-loopback host", () => {
		expect(() => loadEnv({ ...forward, TOKEN_VERIFY_URL: "http://verify.example/api" }))
			.toThrow(/must use https:\/\//);
	});

	it("rejects a URL carrying credentials, a query or a fragment", () => {
		for (const bad of [
			"https://user:pass@verify.example/api",
			"https://verify.example/api?token=1",
			"https://verify.example/api#fragment",
			"https://verify.example/api?",
		]) {
			expect(() => loadEnv({ ...forward, TOKEN_VERIFY_URL: bad })).toThrow(/TOKEN_VERIFY_URL/);
		}
	});

	it("rejects an unparseable URL", () => {
		expect(() => loadEnv({ ...forward, TOKEN_VERIFY_URL: "not a url" }))
			.toThrow(/TOKEN_VERIFY_URL is not a valid URL/);
	});
});