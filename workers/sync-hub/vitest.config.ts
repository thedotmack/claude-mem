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
 *   cmem-uptime-probe-invalid-token
 *                    → 401 {error} JSON — the HEALTHY answer the
 *                      control-plane probe expects (src/control-plane-probe.ts)
 *
 * Phase 5 adds two more outbound targets, dispatched by hostname:
 *   - api.cloudflare.com/client/v4/graphql → mock GraphQL Analytics API,
 *     scripted by the `accountTag` variable in the request body (see
 *     mockGraphQLEndpoint's table). Serves the scheduled-handler wiring
 *     tests; watchdog unit tests use an injected fetchImpl instead.
 *   - discord.test → mock Discord webhook (/webhooks/ok → 204,
 *     /webhooks/fail → 500).
 * Everything else falls through to the verify-endpoint mock.
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Once-tokens already consumed by the mock verify endpoint. */
const consumedOnceTokens = new Set<string>();
const failedProjectorUsers = new Set<string>();
const delayedProjectorCompletions = new Map<string, number>();

function mockVerifyEndpoint(request: Request): Response {
	const auth = request.headers.get("Authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

	if (token === "network-error") {
		throw new Error("simulated network failure reaching the verify endpoint");
	}
	if (token === "cmem-uptime-probe-invalid-token") {
		// Control-plane probe (src/control-plane-probe.ts): a HEALTHY verify
		// endpoint rejects the probe's deliberately bogus token with 401 + a
		// JSON body. (The generic unknown-token fallback below is text/plain,
		// which the probe rightly classifies as unhealthy.)
		return Response.json({ error: "invalid token" }, { status: 401 });
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

/**
 * Mock GraphQL Analytics API, scripted by accountTag (single-group response
 * in the exact shape the watchdog parses — aliases `invocations`/`periodic`):
 *
 *   acct-healthy             → typical 100-user metrics, all under alert
 *   acct-duration-alert      → duration 120 GB-s (alert, below kill 450)
 *   acct-duration-severe     → duration 4000 GB-s (kill — auto-trip)
 *   acct-rows-written-severe → rowsWritten 5,000,000 (kill — auto-trip)
 *   acct-requests-severe     → requests 5,000,000 (severe but NEVER auto-trip)
 *   acct-graphql-errors      → 200 with a GraphQL errors array
 *   acct-no-accounts         → 200 with an empty accounts array
 *   acct-http-500            → HTTP 500
 *   acct-network-error       → throws (unreachable endpoint)
 *   (anything else)          → all-zero metrics
 */
async function mockGraphQLEndpoint(request: Request): Promise<Response> {
	let accountTag = "";
	try {
		const body = (await request.json()) as {
			variables?: { accountTag?: unknown };
		} | null;
		if (typeof body?.variables?.accountTag === "string") {
			accountTag = body.variables.accountTag;
		}
	} catch {
		// fall through to the all-zero default
	}

	if (accountTag === "acct-network-error") {
		throw new Error("simulated network failure reaching the GraphQL API");
	}
	if (accountTag === "acct-http-500") {
		return new Response("graphql down", { status: 500 });
	}
	if (accountTag === "acct-graphql-errors") {
		return Response.json({ data: null, errors: [{ message: "whoops" }] });
	}
	if (accountTag === "acct-no-accounts") {
		return Response.json({ data: { viewer: { accounts: [] } }, errors: null });
	}

	const metrics = {
		requests: 1_200,
		errors: 0,
		duration: 2.5,
		rowsRead: 12_000,
		rowsWritten: 1_300,
		activeTime: 9_000_000,
		inboundWebsocketMsgCount: 40,
	};
	if (accountTag === "acct-duration-alert") metrics.duration = 120;
	if (accountTag === "acct-duration-severe") metrics.duration = 4_000;
	if (accountTag === "acct-rows-written-severe") metrics.rowsWritten = 5_000_000;
	if (accountTag === "acct-requests-severe") metrics.requests = 5_000_000;

	return Response.json({
		data: {
			viewer: {
				accounts: [
					{
						invocations: [{ sum: { requests: metrics.requests, errors: metrics.errors } }],
						periodic: [
							{
								sum: {
									duration: metrics.duration,
									rowsRead: metrics.rowsRead,
									rowsWritten: metrics.rowsWritten,
									activeTime: metrics.activeTime,
									inboundWebsocketMsgCount: metrics.inboundWebsocketMsgCount,
								},
							},
						],
					},
				],
			},
		},
		errors: null,
	});
}

function mockDiscordWebhook(url: URL): Response {
	if (url.pathname === "/webhooks/fail") {
		return new Response("discord down", { status: 500 });
	}
	return new Response(null, { status: 204 });
}

async function mockOutbound(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.hostname === "projection-cases.test") {
		if (url.pathname === "/test/completion") {
			const userId = url.searchParams.get("user_id") ?? "";
			return Response.json({ completions: delayedProjectorCompletions.get(userId) ?? 0 });
		}
		const mode = url.searchParams.get("mode");
		if (mode === "network") throw new Error("simulated projection network failure");
		if (mode === "retryable") return new Response("retry later", { status: 503 });
		if (mode === "truncated") return new Response('{"protocol_version":1', { status: 200 });
		const body = await request.json() as { epoch?: unknown; through_seq?: unknown; user_id?: unknown };
		if (mode === "mismatch") {
			return Response.json({
				protocol_version: 1,
				epoch: body.epoch,
				projected_through_seq: "0",
			});
		}
		if (mode === "nonretryable") {
			return Response.json({ error: "document rejected", retryable: false }, { status: 409 });
		}
		if (mode === "delayed") {
			// Deliberately ignore request.signal. This emulates a Pro handler that
			// keeps applying after its Hub caller has reached the response deadline.
			await new Promise((resolve) => setTimeout(resolve, 75));
			const userId = typeof body.user_id === "string" ? body.user_id : "";
			delayedProjectorCompletions.set(
				userId,
				(delayedProjectorCompletions.get(userId) ?? 0) + 1,
			);
		}
		return Response.json({
			protocol_version: 1,
			epoch: body.epoch,
			projected_through_seq: body.through_seq,
		});
	}
	if (url.hostname === "projector.test" && url.pathname === "/api/internal/sync/project") {
		const body = await request.json() as { epoch?: unknown; through_seq?: unknown; user_id?: unknown };
		if (request.headers.get("Authorization") !== "Bearer test-projector-secret") {
			return new Response("denied", { status: 401 });
		}
		if (body.user_id === "77777777-7777-4777-8777-777777777777") {
			return Response.json(
				{ error: "projection document rejected", retryable: false },
				{ status: 409 },
			);
		}
		if (
			body.user_id === "55555555-5555-4555-8555-555555555555"
			&& !failedProjectorUsers.has(body.user_id)
		) {
			failedProjectorUsers.add(body.user_id);
			return new Response("simulated first projection failure", { status: 503 });
		}
		return Response.json({
			protocol_version: 1,
			epoch: body.epoch,
			projected_through_seq: body.through_seq,
		});
	}
	if (url.hostname === "api.cloudflare.com" && url.pathname === "/client/v4/graphql") {
		return mockGraphQLEndpoint(request);
	}
	if (url.hostname === "discord.test") {
		return mockDiscordWebhook(url);
	}
	return mockVerifyEndpoint(request);
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			// Entrypoint Worker for SELF and the SYNC_HUB Durable Object binding.
			main: "./src/index.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					// A removed pre-launch build accepted this legacy binding as an
					// auth bypass. Supplying it only in Miniflare proves production
					// code ignores it; outbound verification remains mocked below.
					DEV_ALLOW_ANY_TOKEN: "true",
					// Per-request kill-switch reads: SELF tests flip the KV flag
					// and must observe it on the very next request.
					KILL_SWITCH_CACHE_MS: "0",
					INTERNAL_PROJECTOR_URL: "https://projector.test/api/internal/sync/project",
					CMEM_INTERNAL_PROJECTOR_SECRET: "test-projector-secret",
				},
				outboundService: mockOutbound,
			},
		}),
	],
});
