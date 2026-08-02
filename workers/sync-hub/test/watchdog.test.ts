/**
 * Watchdog suite (plan Phase 5 task 1 verification).
 *
 * Unit tests drive runWatchdog directly with an injected fetchImpl (the
 * repo's fetchImpl idiom) so every GraphQL/Discord response is scripted
 * in-test; the KV side uses the REAL env.AUTH_CACHE binding so the
 * kill-switch write path is exercised end-to-end. The scheduled-handler
 * wiring tests call worker.scheduled() with the outboundService mocks from
 * vitest.config.ts (scripted by accountTag).
 *
 * Covered:
 *   - unconfigured → skipped, zero outbound calls (never a false alert)
 *   - healthy metrics → no Discord, no kill switch
 *   - alert breach → Discord payload shape (embeds/title/color/fields)
 *   - severe duration / rowsWritten → kill-switch KV flag written FIRST
 *   - severe requests → severe alert but NEVER auto-trips (ladder rule 4)
 *   - GraphQL error (HTTP 500 / errors array / network throw / no accounts)
 *     → logged query_failed, no alert, no flag, no crash
 *   - threshold env overrides respected (alert and kill)
 *   - Discord failure never blocks the kill-switch write
 *   - re-run while tripped → already_tripped, first flag preserved
 *   - scheduled() export wiring via the config-level outbound mocks
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { KILL_SWITCH_KEY, __resetKillSwitchCacheForTests } from "../src/kill-switch";
import {
	GRAPHQL_ENDPOINT,
	runWatchdog,
	type WatchdogResult,
} from "../src/watchdog";

const WEBHOOK = "https://discord.test/webhooks/unit";

interface RecordedCall {
	url: string;
	headers: Record<string, string>;
	parsed: unknown;
}

interface MetricOverrides {
	requests?: number;
	errors?: number;
	duration?: number;
	rowsRead?: number;
	rowsWritten?: number;
}

/** Single-group GraphQL response in the exact shape the watchdog parses. */
function graphqlBody(overrides: MetricOverrides = {}): Record<string, unknown> {
	return {
		data: {
			viewer: {
				accounts: [
					{
						invocations: [
							{ sum: { requests: overrides.requests ?? 1_200, errors: overrides.errors ?? 0 } },
						],
						periodic: [
							{
								sum: {
									duration: overrides.duration ?? 2.5,
									rowsRead: overrides.rowsRead ?? 12_000,
									rowsWritten: overrides.rowsWritten ?? 1_300,
									activeTime: 9_000_000,
									inboundWebsocketMsgCount: 40,
								},
							},
						],
					},
				],
			},
		},
		errors: null,
	};
}

/**
 * Scripted fetch: GraphQL endpoint answers per `graphql`, the webhook per
 * `discord`. Records every call (URL, headers, parsed JSON body).
 */
function makeFetch(script: {
	graphql?: Response | Error | (() => Response);
	discord?: Response | Error;
}): { impl: typeof fetch; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		let parsed: unknown = null;
		try {
			parsed = init?.body ? JSON.parse(String(init.body)) : null;
		} catch {
			parsed = null;
		}
		calls.push({
			url,
			headers: { ...((init?.headers as Record<string, string>) ?? {}) },
			parsed,
		});
		if (url === GRAPHQL_ENDPOINT) {
			const g = script.graphql ?? Response.json(graphqlBody());
			if (g instanceof Error) throw g;
			if (typeof g === "function") return g();
			return g.clone();
		}
		const d = script.discord ?? new Response(null, { status: 204 });
		if (d instanceof Error) throw d;
		return d.clone();
	}) as typeof fetch;
	return { impl, calls };
}

function watchdogEnv(overrides: Partial<Record<string, string>> = {}): Env {
	return {
		...env,
		ACCOUNT_ID: "acct-unit",
		ANALYTICS_API_TOKEN: "unit-analytics-token",
		DISCORD_WEBHOOK_URL: WEBHOOK,
		...overrides,
	} as Env;
}

function discordCalls(calls: RecordedCall[]): RecordedCall[] {
	return calls.filter((c) => c.url === WEBHOOK);
}

function graphqlCalls(calls: RecordedCall[]): RecordedCall[] {
	return calls.filter((c) => c.url === GRAPHQL_ENDPOINT);
}

afterEach(async () => {
	__resetKillSwitchCacheForTests();
	await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
});

describe("watchdog: configuration + query failures", () => {
	it("skips (no outbound calls) when ACCOUNT_ID / ANALYTICS_API_TOKEN are unconfigured", async () => {
		const { impl, calls } = makeFetch({});
		const result = await runWatchdog(
			watchdogEnv({ ACCOUNT_ID: "", ANALYTICS_API_TOKEN: "" }),
			{ fetchImpl: impl },
		);
		expect(result.status).toBe("skipped");
		expect(calls).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull();
	});

	it("queries the GraphQL endpoint with the tutorial-verbatim auth header and hour window", async () => {
		const { impl, calls } = makeFetch({});
		const now = Date.parse("2026-07-18T12:07:00.000Z");
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl, now: () => now });
		expect(result.status).toBe("healthy");
		const [gql] = graphqlCalls(calls);
		expect(gql).toBeDefined();
		expect(gql.headers.Authorization).toBe("Bearer unit-analytics-token");
		const body = gql.parsed as {
			query: string;
			variables: Record<string, string>;
		};
		// Datasets + fields verified against the live docs / published schema.
		expect(body.query).toContain("durableObjectsInvocationsAdaptiveGroups");
		expect(body.query).toContain("durableObjectsPeriodicGroups");
		expect(body.query).toContain("duration rowsRead rowsWritten");
		expect(body.variables.accountTag).toBe("acct-unit");
		expect(body.variables.scriptName).toBe("sync-hub");
		expect(body.variables.datetimeEnd).toBe("2026-07-18T12:07:00.000Z");
		expect(body.variables.datetimeStart).toBe("2026-07-18T11:07:00.000Z");
	});

	it("filters the periodic dataset by namespaceId when WATCHDOG_DO_NAMESPACE_ID is set", async () => {
		const { impl, calls } = makeFetch({});
		await runWatchdog(watchdogEnv({ WATCHDOG_DO_NAMESPACE_ID: "ns-123" }), {
			fetchImpl: impl,
		});
		const body = graphqlCalls(calls)[0].parsed as {
			query: string;
			variables: Record<string, string>;
		};
		expect(body.query).toContain("namespaceId: $namespaceId");
		expect(body.variables.namespaceId).toBe("ns-123");
	});

	for (const [name, graphql] of [
		["HTTP 500", new Response("boom", { status: 500 })],
		["GraphQL errors array", Response.json({ data: null, errors: [{ message: "nope" }] })],
		["network failure", new Error("simulated network failure")],
		["empty accounts array", Response.json({ data: { viewer: { accounts: [] } }, errors: null })],
	] as Array<[string, Response | Error]>) {
		it(`GraphQL ${name} → query_failed: logged, no alert, no kill switch, no crash`, async () => {
			const { impl, calls } = makeFetch({ graphql });
			const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
			expect(result.status).toBe("query_failed");
			expect(result.reason).toBeTruthy();
			expect(discordCalls(calls)).toHaveLength(0);
			expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull();
		});
	}
});

describe("watchdog: escalation ladder", () => {
	it("healthy metrics → no Discord, no kill switch", async () => {
		const { impl, calls } = makeFetch({});
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
		expect(result.status).toBe("healthy");
		expect(result.breaches).toHaveLength(0);
		expect(result.discord).toBe("skipped");
		expect(result.killSwitch).toBe("none");
		expect(discordCalls(calls)).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull();
	});

	it("duration alert (non-severe) → Discord alert with the release-notify payload shape; no kill switch", async () => {
		// 120 GB-s: above ALERT 50, below KILL 450.
		const { impl, calls } = makeFetch({
			graphql: Response.json(graphqlBody({ duration: 120 })),
		});
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
		expect(result.status).toBe("alert");
		expect(result.discord).toBe("sent");
		expect(result.killSwitch).toBe("none");
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull();

		const [call] = discordCalls(calls);
		expect(call).toBeDefined();
		// Payload shape copied from scripts/discord-release-notify.js:
		// {embeds: [{title, description, color, fields, footer, timestamp}]}.
		const payload = call.parsed as {
			embeds: Array<{
				title: string;
				description: string;
				color: number;
				fields: Array<{ name: string; value: string; inline: boolean }>;
				footer: { text: string };
				timestamp: string;
			}>;
		};
		expect(payload.embeds).toHaveLength(1);
		const embed = payload.embeds[0];
		expect(embed.title).toContain("sync-hub watchdog");
		expect(embed.title).not.toContain("SEVERE");
		expect(embed.color).toBe(0xf59e0b); // amber = alert tier
		expect(embed.description).toContain("duration=120.00 GB-s");
		const durationField = embed.fields.find((f) => f.name.includes("duration GB-s/hour"));
		expect(durationField).toBeDefined();
		expect(durationField!.value).toContain("120");
		expect(durationField!.value).toContain("alert ≥ 50");
		expect(durationField!.value).toContain("kill ≥ 450");
		const killField = embed.fields.find((f) => f.name === "Kill switch");
		expect(killField!.value).toBe("Not tripped.");
		expect(typeof embed.timestamp).toBe("string");
		expect(embed.footer.text).toContain("watchdog");
	});

	it("severe duration → kill switch tripped (flag content names the breach) + severe Discord", async () => {
		const { impl, calls } = makeFetch({
			graphql: Response.json(graphqlBody({ duration: 4_000 })),
		});
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
		expect(result.status).toBe("severe");
		expect(result.killSwitch).toBe("tripped");
		expect(result.discord).toBe("sent");

		const raw = await env.AUTH_CACHE.get(KILL_SWITCH_KEY);
		expect(raw).not.toBeNull();
		const flag = JSON.parse(raw!) as {
			source: string;
			tripped_at: string;
			breaches: Array<{ metric: string; value: number; kill: number }>;
		};
		expect(flag.source).toBe("watchdog");
		expect(typeof flag.tripped_at).toBe("string");
		expect(flag.breaches).toEqual([{ metric: "duration_gbs", value: 4_000, kill: 450 }]);

		const embed = (discordCalls(calls)[0].parsed as {
			embeds: Array<{ title: string; color: number; fields: Array<{ name: string; value: string }> }>;
		}).embeds[0];
		expect(embed.title).toContain("SEVERE");
		expect(embed.color).toBe(0xdc2626); // red = severe tier
		expect(embed.fields.find((f) => f.name === "Kill switch")!.value).toContain("AUTO-TRIPPED");
	});

	it("severe rowsWritten → kill switch tripped", async () => {
		const { impl } = makeFetch({
			graphql: Response.json(graphqlBody({ rowsWritten: 5_000_000 })),
		});
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
		expect(result.status).toBe("severe");
		expect(result.killSwitch).toBe("tripped");
		const flag = JSON.parse((await env.AUTH_CACHE.get(KILL_SWITCH_KEY))!) as {
			breaches: Array<{ metric: string }>;
		};
		expect(flag.breaches.map((b) => b.metric)).toEqual(["rows_written"]);
	});

	it("severe requests → severe Discord but NO auto-trip (poll mode cannot reduce HTTP volume)", async () => {
		const { impl, calls } = makeFetch({
			graphql: Response.json(graphqlBody({ requests: 5_000_000 })),
		});
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
		expect(result.status).toBe("severe");
		expect(result.killSwitch).toBe("none");
		expect(result.discord).toBe("sent");
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull();
		expect(discordCalls(calls)).toHaveLength(1);
	});

	it("a Discord failure never blocks the kill-switch write (switch first, ping second)", async () => {
		const { impl } = makeFetch({
			graphql: Response.json(graphqlBody({ duration: 4_000 })),
			discord: new Error("webhook unreachable"),
		});
		const result = await runWatchdog(watchdogEnv(), { fetchImpl: impl });
		expect(result.killSwitch).toBe("tripped");
		expect(result.discord).toBe("failed");
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).not.toBeNull();
	});

	it("breach with no webhook configured → not_configured (logged), kill switch still works", async () => {
		const { impl, calls } = makeFetch({
			graphql: Response.json(graphqlBody({ duration: 4_000 })),
		});
		const result = await runWatchdog(watchdogEnv({ DISCORD_WEBHOOK_URL: "" }), {
			fetchImpl: impl,
		});
		expect(result.discord).toBe("not_configured");
		expect(result.killSwitch).toBe("tripped");
		expect(discordCalls(calls)).toHaveLength(0);
	});

	it("a second severe run while tripped reports already_tripped and preserves the first flag", async () => {
		const graphql = () => Response.json(graphqlBody({ duration: 4_000 }));
		const first = await runWatchdog(watchdogEnv(), { fetchImpl: makeFetch({ graphql }).impl });
		expect(first.killSwitch).toBe("tripped");
		const firstFlag = await env.AUTH_CACHE.get(KILL_SWITCH_KEY);

		const second = await runWatchdog(watchdogEnv(), { fetchImpl: makeFetch({ graphql }).impl });
		expect(second.killSwitch).toBe("already_tripped");
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBe(firstFlag);
	});
});

describe("watchdog: threshold env overrides", () => {
	it("respects a lowered alert threshold", async () => {
		// duration 2.5 is healthy at the default 50 — but alerts at override 1.
		const { impl } = makeFetch({});
		const result = await runWatchdog(
			watchdogEnv({ WATCHDOG_DURATION_ALERT_GBS: "1" }),
			{ fetchImpl: impl },
		);
		expect(result.status).toBe("alert");
		expect(result.breaches[0]).toMatchObject({
			metric: "duration_gbs",
			alertThreshold: 1,
			killThreshold: 450,
			severe: false,
		});
	});

	it("respects a lowered kill threshold (auto-trip family)", async () => {
		const { impl } = makeFetch({});
		const result = await runWatchdog(
			watchdogEnv({ WATCHDOG_ROWS_READ_ALERT: "1000", WATCHDOG_ROWS_READ_KILL: "10000" }),
			{ fetchImpl: impl }, // rowsRead default fixture = 12,000
		);
		expect(result.status).toBe("severe");
		expect(result.killSwitch).toBe("tripped");
	});

	it("a kill threshold set BELOW the (default) alert threshold still engages (breach gate is min(alert, kill))", async () => {
		// Only the kill value is lowered — the alert stays at the 5,000,000
		// default, far above the 12,000-row fixture. Gating breaches on the
		// alert threshold alone would make this configuration silently inert;
		// the DEPLOY.md §5 rehearsal depends on it engaging.
		const { impl } = makeFetch({});
		const result = await runWatchdog(
			watchdogEnv({ WATCHDOG_ROWS_READ_KILL: "10000" }),
			{ fetchImpl: impl }, // rowsRead default fixture = 12,000
		);
		expect(result.status).toBe("severe");
		expect(result.killSwitch).toBe("tripped");
		expect(result.breaches[0]).toMatchObject({
			metric: "rows_read",
			killThreshold: 10_000,
			severe: true,
			autoTrip: true,
		});
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).not.toBeNull();
	});

	it("ignores malformed overrides and keeps the code defaults", async () => {
		const { impl } = makeFetch({});
		const result = await runWatchdog(
			watchdogEnv({ WATCHDOG_DURATION_ALERT_GBS: "not-a-number" }),
			{ fetchImpl: impl },
		);
		expect(result.status).toBe("healthy");
	});
});

describe("watchdog: scheduled handler wiring", () => {
	function controller(): ScheduledController {
		return {
			scheduledTime: Date.now(),
			cron: "7 * * * *",
			noRetry() {},
		} as ScheduledController;
	}

	it("scheduled() runs the watchdog against the outbound mocks: severe account trips the KV flag", async () => {
		const ctx = createExecutionContext();
		await worker.scheduled(
			controller(),
			watchdogEnv({ ACCOUNT_ID: "acct-duration-severe", DISCORD_WEBHOOK_URL: "https://discord.test/webhooks/ok" }),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).not.toBeNull();
	});

	it("scheduled() with a healthy account leaves the flag alone", async () => {
		const ctx = createExecutionContext();
		await worker.scheduled(
			controller(),
			watchdogEnv({ ACCOUNT_ID: "acct-healthy", DISCORD_WEBHOOK_URL: "https://discord.test/webhooks/ok" }),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull();
	});
});

// Type-level guard: runWatchdog's result surface is what the scheduled
// handler logs — keep the union in sync with the tests above.
const _statusCheck: WatchdogResult["status"][] = [
	"skipped",
	"query_failed",
	"healthy",
	"alert",
	"severe",
];
void _statusCheck;
