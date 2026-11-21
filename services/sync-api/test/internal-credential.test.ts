import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasInternalCredential, type SyncApiApp } from "../src/index";
import { PROJECTOR_SECRET, stopTrackedApps, trackedApp } from "./helpers";
import type { SyncApiEnv } from "../src/env";

/** A minimal env carrying only what hasInternalCredential reads. */
function envWith(secret: string | undefined): SyncApiEnv {
	return {
		CMEM_INTERNAL_PROJECTOR_SECRET: secret,
	} as SyncApiEnv;
}

function bearer(value: string): Request {
	return new Request("http://127.0.0.1/internal/v1/ping", {
		headers: { Authorization: `Bearer ${value}` },
	});
}

describe("hasInternalCredential", () => {
	it("accepts the configured secret as a Bearer credential", () => {
		expect(hasInternalCredential(bearer("secret-abc"), envWith("secret-abc"))).toBe(true);
	});

	it("rejects a wrong secret, a different scheme, and a missing header", () => {
		expect(hasInternalCredential(bearer("secret-abx"), envWith("secret-abc"))).toBe(false);
		expect(hasInternalCredential(bearer("secret-abc-longer"), envWith("secret-abc"))).toBe(false);
		expect(
			hasInternalCredential(
				new Request("http://127.0.0.1/internal/v1/ping", {
					headers: { Authorization: "secret-abc" },
				}),
				envWith("secret-abc"),
			),
		).toBe(false);
		expect(hasInternalCredential(new Request("http://127.0.0.1/internal/v1/ping"), envWith("secret-abc"))).toBe(false);
	});

	it("refuses everything when no secret is configured", () => {
		expect(hasInternalCredential(bearer("secret-abc"), envWith(undefined))).toBe(false);
		expect(hasInternalCredential(bearer(""), envWith(""))).toBe(false);
	});

	// The credential gates the projection-write surface (/internal/v1/*), and
	// the comparison takes an attacker-controlled header. A plain `===` leaks
	// the secret byte-by-byte through response timing, so the implementation
	// must compare through crypto.timingSafeEqual. This reads the source so a
	// revert to a plain string comparison fails the suite even though the
	// functional tests above still pass. Comments are stripped first: a
	// mention of timingSafeEqual in prose must not satisfy the check, only an
	// actual call does.
	it("compares the credential in constant time, not with a plain string equality", () => {
		const code = functionCode("hasInternalCredential");
		expect(code).toContain("timingSafeEqual(");
		expect(plainHeaderComparisons(code)).toEqual([]);
	});

	// The repair drain is reached before client auth, so it must go through the
	// same check instead of comparing the header itself.
	it("gates the repair drain through hasInternalCredential", () => {
		const code = functionCode("handleRepairDrain");
		expect(code).toContain("hasInternalCredential(request, app.env)");
		expect(code).not.toContain("Authorization");
		expect(plainHeaderComparisons(code)).toEqual([]);
	});
});

/** The body of `async? function <name>` in src/index.ts with comments removed. */
function functionCode(name: string): string {
	const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
	const start = source.search(new RegExp(`(?:async )?function ${name}\\b`));
	expect(start).toBeGreaterThan(-1);
	const end = source.indexOf("\n}", start);
	expect(end).toBeGreaterThan(start);
	return source
		.slice(start, end)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

/** Lines that compare against the Authorization header or a Bearer string with ===/!==. */
function plainHeaderComparisons(code: string): string[] {
	return code
		.split("\n")
		.filter(line => /[!=]==/.test(line) && /Authorization|Bearer/.test(line))
		.map(line => line.trim());
}

describe("POST /internal/v1/projection/drain auth", () => {
	afterAll(stopTrackedApps);

	function drain(app: SyncApiApp, authorization: string | null, body: string): Promise<Response> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (authorization !== null) headers.Authorization = authorization;
		return fetch(`${app.url}/internal/v1/projection/drain`, { method: "POST", headers, body });
	}

	it("answers 401 for a missing header, a near-miss secret and a longer one", async () => {
		const { app } = await trackedApp();
		const body = JSON.stringify({ protocol_version: 1, user_id: "user" });
		const nearMiss = `Bearer ${PROJECTOR_SECRET.slice(0, -1)}x`;
		for (const authorization of [null, nearMiss, `Bearer ${PROJECTOR_SECRET}-longer`]) {
			const response = await drain(app, authorization, body);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ error: "invalid internal projector credential" });
		}
	});

	it("lets the configured secret past auth", async () => {
		const { app } = await trackedApp();
		const response = await drain(app, `Bearer ${PROJECTOR_SECRET}`, "not json");
		expect(response.status).toBe(400);
	});
});
