import { describe, expect, it } from "bun:test";
import { loadEnv } from "../src/env";

// The projector URL receives `Authorization: Bearer <CMEM_INTERNAL_PROJECTOR_SECRET>`
// on every drain. FORWARD_ORIGIN next to it is validated (https, or loopback
// http, no credentials/query/fragment); this URL was only trimmed, so a typo or
// a copied `http://` address sent the secret in cleartext to whatever host it
// named. Forward mode keeps DATABASE_URL optional, so every case uses it.

const forward = { FORWARD_ORIGIN: "https://example.com" };

describe("INTERNAL_PROJECTOR_URL", () => {
	it("stays empty when unset or blank", () => {
		expect(loadEnv(forward).INTERNAL_PROJECTOR_URL).toBe("");
		expect(loadEnv({ ...forward, INTERNAL_PROJECTOR_URL: "   " }).INTERNAL_PROJECTOR_URL).toBe("");
	});

	it("accepts an https endpoint and normalizes its trailing slash", () => {
		expect(loadEnv({ ...forward, INTERNAL_PROJECTOR_URL: "https://projector.example/api/v1/" }).INTERNAL_PROJECTOR_URL)
			.toBe("https://projector.example/api/v1");
	});

	it("accepts http only for a loopback host", () => {
		for (const loopback of ["http://127.0.0.1:8787/project", "http://localhost:8787/project", "http://[::1]:8787/project"]) {
			expect(loadEnv({ ...forward, INTERNAL_PROJECTOR_URL: loopback }).INTERNAL_PROJECTOR_URL).toBe(loopback);
		}
	});

	it("rejects plain http to a non-loopback host", () => {
		expect(() => loadEnv({ ...forward, INTERNAL_PROJECTOR_URL: "http://projector.example/api" }))
			.toThrow(/must use https:\/\//);
	});

	it("rejects a URL carrying credentials, a query or a fragment", () => {
		for (const bad of [
			"https://user:pass@projector.example/api",
			"https://projector.example/api?token=1",
			"https://projector.example/api#fragment",
			"https://projector.example/api?",
		]) {
			expect(() => loadEnv({ ...forward, INTERNAL_PROJECTOR_URL: bad })).toThrow(/INTERNAL_PROJECTOR_URL/);
		}
	});

	it("rejects an unparseable URL", () => {
		expect(() => loadEnv({ ...forward, INTERNAL_PROJECTOR_URL: "not a url" }))
			.toThrow(/INTERNAL_PROJECTOR_URL is not a valid URL/);
	});
});