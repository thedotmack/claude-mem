/**
 * Vitest config — @cloudflare/vitest-pool-workers ≥0.18 Vite-plugin form
 * (plan Phase 0.3; `defineWorkersConfig` was removed in v0.13, do not use it).
 * Tests import their APIs from "cloudflare:test".
 *
 * Outbound-fetch mocking: 0.18.x removed the old `fetchMock` export from
 * "cloudflare:test" (verified against the installed typings and the runtime
 * module — no such export). Instead, miniflare's `outboundService` option
 * (a plain handler function, verified in miniflare's typings) intercepts ALL
 * outbound fetches from the Worker under test. The only outbound fetch the
 * front Worker makes is token verification, so the handler below emulates the
 * cmem.ai verify endpoint deterministically, keyed by the presented token:
 *
 *   valid-for:<id>   → 200 {userId: <id>}
 *   snake-for:<id>   → 200 {user_id: <id>}
 *   once-for:<id>:<nonce>
 *                    → 200 {userId: <id>} the FIRST call, 500 afterwards
 *                      (lets tests prove the KV verdict cache: a second
 *                      authorized request must have skipped the re-fetch)
 *   wrong-user       → 200 {userId: "someone-else"} (canonical id mismatch)
 *   no-id            → 200 {} (canonical id missing)
 *   denied-401/403   → 401 / 403
 *   upstream-500     → 500
 *   network-error    → throws (unreachable endpoint)
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Once-tokens already consumed by the mock verify endpoint. */
const consumedOnceTokens = new Set<string>();

function mockVerifyEndpoint(request: Request): Response {
	const auth = request.headers.get("Authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

	if (token === "network-error") {
		throw new Error("simulated network failure reaching the verify endpoint");
	}
	if (token === "denied-401") return new Response("denied", { status: 401 });
	if (token === "denied-403") return new Response("denied", { status: 403 });
	if (token === "upstream-500") return new Response("boom", { status: 500 });
	if (token === "wrong-user") return Response.json({ userId: "someone-else" });
	if (token === "no-id") return Response.json({ ok: true });
	if (token.startsWith("valid-for:")) {
		return Response.json({ userId: token.slice("valid-for:".length) });
	}
	if (token.startsWith("snake-for:")) {
		return Response.json({ user_id: token.slice("snake-for:".length) });
	}
	if (token.startsWith("once-for:")) {
		if (consumedOnceTokens.has(token)) {
			return new Response("verify endpoint re-hit for a once-token", {
				status: 500,
			});
		}
		consumedOnceTokens.add(token);
		return Response.json({ userId: token.slice("once-for:".length).split(":")[0] });
	}
	return new Response("unknown test token", { status: 401 });
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Entrypoint Worker for SELF and the SYNC_HUB Durable Object binding.
			main: "./src/index.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Force the REAL auth path in tests: explicitly override any
				// local .dev.vars (which sets DEV_ALLOW_ANY_TOKEN=true for
				// `wrangler dev`) so CI and local runs behave identically.
				bindings: { DEV_ALLOW_ANY_TOKEN: "" },
				outboundService: mockVerifyEndpoint,
			},
		}),
	],
});
