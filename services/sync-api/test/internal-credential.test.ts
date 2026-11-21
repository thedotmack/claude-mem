import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasInternalCredential } from "../src/index";
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
	// functional tests above still pass. Comment lines are stripped first: a
	// mention of timingSafeEqual in prose must not satisfy the check, only an
	// actual call does.
	it("compares the credential in constant time, not with a plain string equality", () => {
		const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
		const start = source.indexOf("function hasInternalCredential");
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("\n}", start);
		const code = source
			.slice(start, end)
			.split("\n")
			.filter(line => {
				const trimmed = line.trim();
				return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
			})
			.join("\n");
		expect(code).toContain("timingSafeEqual(");
	});
});
