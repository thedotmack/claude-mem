/**
 * Control-plane uptime probe suite (launch Phase 5 task 4 verification).
 *
 * Unit tests drive runControlPlaneProbe directly with an injected fetchImpl
 * (the repo's fetchImpl idiom, mirroring watchdog.test.ts) so every verify /
 * Discord response is scripted in-test; the KV side uses the REAL
 * env.AUTH_CACHE binding so the anti-flap state machine is exercised end to
 * end. The cron dispatch tests call worker.scheduled() with the
 * outboundService mocks from vitest.config.ts.
 *
 * Covered:
 *   - healthy 401/403+JSON → no alert, no KV write (steady state is silent)
 *   - first failure + confirm-retry → ONE Discord post + KV failing state
 *   - failure whose confirm-retry is healthy → blip: no alert, no state
 *   - still failing inside 30 min → suppressed: no repost, KV untouched
 *   - still failing after 30 min → re-alert + last_alert_at advanced
 *   - recovery → green embed + state cleared
 *   - 2xx for the bogus token → distinct SECURITY-flavored alert
 *   - Discord failure → swallowed with a log, KV state still written
 *   - timeout / network error / non-JSON 401 / unexpected status classes
 *   - maintenance silence: future silenced_until skips everything; expired
 *     silence is cleaned up quietly on a healthy run
 *   - cron dispatch: "7 * * * *" still reaches the watchdog (no regression),
 *     "*\/5 * * * *" reaches the probe and never runs the watchdog
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import {
	CONTROL_PLANE_PROBE_CRON,
	PROBE_REALERT_MS,
	PROBE_STATE_KEY,
	PROBE_TOKEN,
	PROBE_USER_ID,
	runControlPlaneProbe,
	type ProbeResult,
} from "../src/control-plane-probe";
import { KILL_SWITCH_KEY, __resetKillSwitchCacheForTests } from "../src/kill-switch";

const VERIFY_URL = "https://verify.test/api/pro/sync/verify";
const WEBHOOK = "https://discord.test/webhooks/probe-unit";
const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const NOW_ISO = "2026-07-22T12:00:00.000Z";

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	parsed: unknown;
}

interface RecordedEmbed {
	title: string;
	description: string;
	color: number;
	fields: Array<{ name: string; value: string; inline: boolean }>;
	footer: { text: string };
	timestamp: string;
}

/** One scripted step for the verify endpoint. "hang" never resolves. */
type VerifyStep = Response | Error | "hang";

/**
 * Scripted fetch: the verify endpoint consumes `verify` steps in order (a
 * test bug if called more often than scripted), the webhook answers per
 * `discord`. Records every call (URL, method, headers, parsed JSON body).
 */
function makeFetch(script: { verify?: VerifyStep[]; discord?: Response | Error }): {
	impl: typeof fetch;
	calls: RecordedCall[];
	verifyCalls: () => RecordedCall[];
	discordCalls: () => RecordedCall[];
	discordEmbed: (index?: number) => RecordedEmbed;
} {
	const calls: RecordedCall[] = [];
	const queue = [...(script.verify ?? [])];
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
			method: init?.method ?? "GET",
			headers: { ...((init?.headers as Record<string, string>) ?? {}) },
			parsed,
		});
		if (url === VERIFY_URL) {
			const step = queue.shift();
			if (step === undefined) {
				throw new Error("test bug: verify endpoint called more times than scripted");
			}
			if (step === "hang") return new Promise<Response>(() => {});
			if (step instanceof Error) throw step;
			return step.clone();
		}
		const d = script.discord ?? new Response(null, { status: 204 });
		if (d instanceof Error) throw d;
		return d.clone();
	}) as typeof fetch;
	const discordCalls = () => calls.filter((c) => c.url === WEBHOOK);
	return {
		impl,
		calls,
		verifyCalls: () => calls.filter((c) => c.url === VERIFY_URL),
		discordCalls,
		discordEmbed: (index = 0) => {
			const payload = discordCalls()[index].parsed as { embeds: RecordedEmbed[] };
			expect(payload.embeds).toHaveLength(1);
			return payload.embeds[0];
		},
	};
}

function probeEnv(overrides: Partial<Record<string, string>> = {}): Env {
	return {
		...env,
		TOKEN_VERIFY_URL: VERIFY_URL,
		DISCORD_WEBHOOK_URL: WEBHOOK,
		...overrides,
	} as Env;
}

/** The healthy answer: 401 + JSON (requires the app AND its DB lookup). */
function healthy401(): Response {
	return Response.json({ error: "invalid token" }, { status: 401 });
}

function http500(): Response {
	return new Response("Internal Server Error", { status: 500 });
}

function html401(): Response {
	return new Response("<html>edge maintenance page</html>", {
		status: 401,
		headers: { "Content-Type": "text/html" },
	});
}

/** The security alarm: the bogus token was ACCEPTED. */
function bogus200(): Response {
	return Response.json({ userId: PROBE_USER_ID }, { status: 200 });
}

async function seedFailingState(
	lastAlertAgoMs: number,
	firstFailureAt = "2026-07-22T11:00:00.000Z",
): Promise<string> {
	const state = JSON.stringify({
		status: "failing",
		first_failure_at: firstFailureAt,
		last_alert_at: new Date(NOW - lastAlertAgoMs).toISOString(),
		kind: "http_5xx",
		reason: "HTTP 500",
		security: false,
	});
	await env.AUTH_CACHE.put(PROBE_STATE_KEY, state);
	return state;
}

afterEach(async () => {
	__resetKillSwitchCacheForTests();
	await env.AUTH_CACHE.delete(PROBE_STATE_KEY);
	await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
});

describe("control-plane probe: configuration + healthy steady state", () => {
	it("skips (no outbound calls) when TOKEN_VERIFY_URL is unconfigured", async () => {
		const { impl, calls } = makeFetch({});
		const result = await runControlPlaneProbe(probeEnv({ TOKEN_VERIFY_URL: "" }), {
			fetchImpl: impl,
		});
		expect(result.status).toBe("skipped");
		expect(calls).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull();
	});

	it("healthy 401+JSON → nothing: no Discord, no KV write, exactly one probe request", async () => {
		const { impl, verifyCalls, discordCalls } = makeFetch({ verify: [healthy401()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("healthy");
		expect(result.discord).toBe("skipped");
		expect(result.kv).toBe("none");
		expect(discordCalls()).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull();

		// The probe presents the documented bogus identity, nothing else.
		const [probe] = verifyCalls();
		expect(verifyCalls()).toHaveLength(1); // healthy needs no confirm-retry
		expect(probe.method).toBe("GET");
		expect(probe.headers.Authorization).toBe(`Bearer ${PROBE_TOKEN}`);
		expect(probe.headers["X-User-Id"]).toBe(PROBE_USER_ID);
	});

	it("healthy 403+JSON is also healthy", async () => {
		const { impl } = makeFetch({
			verify: [Response.json({ error: "forbidden" }, { status: 403 })],
		});
		const result = await runControlPlaneProbe(probeEnv(), { fetchImpl: impl });
		expect(result.status).toBe("healthy");
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull();
	});
});

describe("control-plane probe: first failure + confirm retry", () => {
	it("5xx confirmed by the in-run retry → ONE red Discord post + failing KV state", async () => {
		const { impl, verifyCalls, discordCalls, discordEmbed } = makeFetch({
			verify: [http500(), http500()],
		});
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("alerted");
		expect(result.kind).toBe("http_5xx");
		expect(result.security).toBe(false);
		expect(result.discord).toBe("sent");
		expect(result.kv).toBe("written");
		expect(verifyCalls()).toHaveLength(2); // probe + confirm
		expect(discordCalls()).toHaveLength(1);

		const embed = discordEmbed();
		expect(embed.title).toContain("control plane DOWN");
		expect(embed.color).toBe(0xdc2626); // red = outage tier
		expect(embed.description).toContain("HTTP 500");
		expect(embed.fields.find((f) => f.name === "Probe target")!.value).toBe(VERIFY_URL);

		const state = JSON.parse((await env.AUTH_CACHE.get(PROBE_STATE_KEY))!) as {
			status: string;
			first_failure_at: string;
			last_alert_at: string;
			kind: string;
			security: boolean;
		};
		expect(state.status).toBe("failing");
		expect(state.first_failure_at).toBe(NOW_ISO);
		expect(state.last_alert_at).toBe(NOW_ISO);
		expect(state.kind).toBe("http_5xx");
		expect(state.security).toBe(false);
	});

	it("a single blip (failure whose retry is healthy) → no alert, no state", async () => {
		const { impl, verifyCalls, discordCalls } = makeFetch({
			verify: [http500(), healthy401()],
		});
		const result = await runControlPlaneProbe(probeEnv(), { fetchImpl: impl });
		expect(result.status).toBe("blip");
		expect(result.discord).toBe("skipped");
		expect(result.kv).toBe("none");
		expect(verifyCalls()).toHaveLength(2);
		expect(discordCalls()).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull();
	});

	for (const [name, steps, kind] of [
		["network error", [new Error("boom"), new Error("boom")], "unreachable"],
		["non-JSON 401 (HTML edge page)", [html401(), html401()], "non_json"],
		[
			"unexpected status (404)",
			[new Response("nope", { status: 404 }), new Response("nope", { status: 404 })],
			"unexpected_status",
		],
	] as Array<[string, VerifyStep[], string]>) {
		it(`${name} → confirmed alert with kind "${kind}"`, async () => {
			const { impl, discordCalls } = makeFetch({ verify: steps });
			const result = await runControlPlaneProbe(probeEnv(), {
				fetchImpl: impl,
				now: () => NOW,
			});
			expect(result.status).toBe("alerted");
			expect(result.kind).toBe(kind);
			expect(discordCalls()).toHaveLength(1);
			expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).not.toBeNull();
		});
	}

	it("a hung endpoint times out and alerts with kind \"timeout\"", async () => {
		const { impl, discordCalls } = makeFetch({ verify: ["hang", "hang"] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
			timeoutMs: 10, // test seam; production pins PROBE_TIMEOUT_MS = 10s
		});
		expect(result.status).toBe("alerted");
		expect(result.kind).toBe("timeout");
		expect(discordCalls()).toHaveLength(1);
	});
});

describe("control-plane probe: anti-flap while failing", () => {
	it("still failing inside the 30-min window → suppressed: no repost, no retry, KV untouched", async () => {
		const seeded = await seedFailingState(10 * 60 * 1000); // alerted 10 min ago
		const { impl, verifyCalls, discordCalls } = makeFetch({ verify: [http500()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("suppressed");
		expect(result.discord).toBe("skipped");
		expect(result.kv).toBe("none");
		expect(verifyCalls()).toHaveLength(1); // already failing ⇒ no confirm-retry
		expect(discordCalls()).toHaveLength(0);
		// The 5-minute steady failing state writes NOTHING to KV.
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBe(seeded);
	});

	it("still failing after 30 min → re-alert, last_alert_at advanced, first_failure_at preserved", async () => {
		await seedFailingState(PROBE_REALERT_MS + 60 * 1000); // alerted 31 min ago
		const { impl, discordCalls, discordEmbed } = makeFetch({ verify: [http500()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("realerted");
		expect(result.discord).toBe("sent");
		expect(result.kv).toBe("written");
		expect(discordCalls()).toHaveLength(1);
		expect(discordEmbed().title).toContain("STILL DOWN");

		const state = JSON.parse((await env.AUTH_CACHE.get(PROBE_STATE_KEY))!) as {
			first_failure_at: string;
			last_alert_at: string;
		};
		expect(state.first_failure_at).toBe("2026-07-22T11:00:00.000Z"); // preserved
		expect(state.last_alert_at).toBe(NOW_ISO); // advanced
	});

	it("recovery → one green embed + state cleared", async () => {
		await seedFailingState(10 * 60 * 1000);
		const { impl, discordCalls, discordEmbed } = makeFetch({ verify: [healthy401()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("recovered");
		expect(result.discord).toBe("sent");
		expect(result.kv).toBe("cleared");
		expect(discordCalls()).toHaveLength(1);

		const embed = discordEmbed();
		expect(embed.title).toContain("recovered");
		expect(embed.color).toBe(0x16a34a); // green
		expect(embed.fields.find((f) => f.name === "Was failing since")!.value).toBe(
			"2026-07-22T11:00:00.000Z",
		);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull();
	});
});

describe("control-plane probe: security alarm", () => {
	it("2xx for the bogus token → distinct SECURITY-flavored red alert + security:true state", async () => {
		const { impl, discordEmbed } = makeFetch({ verify: [bogus200(), bogus200()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("alerted");
		expect(result.kind).toBe("security_2xx");
		expect(result.security).toBe(true);

		const embed = discordEmbed();
		expect(embed.title).toContain("SECURITY");
		expect(embed.title).toContain("ACCEPTED a bogus token");
		expect(embed.color).toBe(0x7f1d1d); // distinct from the 0xdc2626 outage red
		expect(embed.description).toContain("authentication bypass");

		const state = JSON.parse((await env.AUTH_CACHE.get(PROBE_STATE_KEY))!) as {
			kind: string;
			security: boolean;
		};
		expect(state.kind).toBe("security_2xx");
		expect(state.security).toBe(true);
	});
});

describe("control-plane probe: failure containment", () => {
	it("a Discord failure is swallowed with a log — KV state still written, nothing thrown", async () => {
		const { impl, discordCalls } = makeFetch({
			verify: [http500(), http500()],
			discord: new Error("webhook unreachable"),
		});
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("alerted");
		expect(result.discord).toBe("failed");
		expect(result.kv).toBe("written"); // state first, ping second
		expect(discordCalls()).toHaveLength(1); // attempted exactly once
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).not.toBeNull();
	});

	it("no webhook configured → not_configured (logged), state still written", async () => {
		const { impl, discordCalls } = makeFetch({ verify: [http500(), http500()] });
		const result = await runControlPlaneProbe(probeEnv({ DISCORD_WEBHOOK_URL: "" }), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("alerted");
		expect(result.discord).toBe("not_configured");
		expect(result.kv).toBe("written");
		expect(discordCalls()).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).not.toBeNull();
	});
});

describe("control-plane probe: maintenance silence (DEPLOY.md §7)", () => {
	it("a future silenced_until skips everything — not even a probe fetch", async () => {
		const marker = JSON.stringify({
			silenced_until: new Date(NOW + 60 * 60 * 1000).toISOString(),
		});
		await env.AUTH_CACHE.put(PROBE_STATE_KEY, marker);
		const { impl, calls } = makeFetch({});
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("silenced");
		expect(calls).toHaveLength(0);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBe(marker);
	});

	it("an expired silence + healthy endpoint is cleaned up quietly (no green post)", async () => {
		await env.AUTH_CACHE.put(
			PROBE_STATE_KEY,
			JSON.stringify({ silenced_until: new Date(NOW - 1000).toISOString() }),
		);
		const { impl, discordCalls } = makeFetch({ verify: [healthy401()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("silence_cleared");
		expect(discordCalls()).toHaveLength(0); // there was never an alert to close
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull();
	});

	it("an expired silence + confirmed failure alerts like a first failure", async () => {
		await env.AUTH_CACHE.put(
			PROBE_STATE_KEY,
			JSON.stringify({ silenced_until: new Date(NOW - 1000).toISOString() }),
		);
		const { impl, discordCalls } = makeFetch({ verify: [http500(), http500()] });
		const result = await runControlPlaneProbe(probeEnv(), {
			fetchImpl: impl,
			now: () => NOW,
		});
		expect(result.status).toBe("alerted");
		expect(discordCalls()).toHaveLength(1);
		const state = JSON.parse((await env.AUTH_CACHE.get(PROBE_STATE_KEY))!) as {
			status: string;
		};
		expect(state.status).toBe("failing");
	});
});

describe("cron dispatch: two schedules, one scheduled handler", () => {
	function controller(cron: string): ScheduledController {
		return { scheduledTime: Date.now(), cron, noRetry() {} } as ScheduledController;
	}

	it('"7 * * * *" still reaches the watchdog (no regression) and never the probe', async () => {
		const ctx = createExecutionContext();
		await worker.scheduled(
			controller("7 * * * *"),
			probeEnv({
				ACCOUNT_ID: "acct-duration-severe", // outbound-mock: severe → trips the switch
				ANALYTICS_API_TOKEN: "unit-analytics-token",
				DISCORD_WEBHOOK_URL: "https://discord.test/webhooks/ok",
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).not.toBeNull(); // watchdog ran
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull(); // probe did not
	});

	it(`"${CONTROL_PLANE_PROBE_CRON}" reaches the probe (recovery observed) and never the watchdog`, async () => {
		// Pre-seed a failing state; the outbound mock answers the probe token
		// with the healthy 401+JSON, so a probe run MUST clear it (recovery).
		await seedFailingState(10 * 60 * 1000);
		const ctx = createExecutionContext();
		await worker.scheduled(
			controller(CONTROL_PLANE_PROBE_CRON),
			probeEnv({
				// TOKEN_VERIFY_URL: any URL — the outboundService intercepts it.
				TOKEN_VERIFY_URL: "https://cmem.ai/api/pro/sync/verify",
				// Were the watchdog to run instead, THIS account would trip the
				// kill switch — its absence below proves the dispatch.
				ACCOUNT_ID: "acct-duration-severe",
				ANALYTICS_API_TOKEN: "unit-analytics-token",
				DISCORD_WEBHOOK_URL: "https://discord.test/webhooks/ok",
			}),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(await env.AUTH_CACHE.get(PROBE_STATE_KEY)).toBeNull(); // probe recovered + cleared
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBeNull(); // watchdog did NOT run
	});
});

// Type-level guard: runControlPlaneProbe's result surface is what the
// scheduled handler logs — keep the union in sync with the tests above.
const _statusCheck: ProbeResult["status"][] = [
	"skipped",
	"silenced",
	"healthy",
	"blip",
	"alerted",
	"suppressed",
	"realerted",
	"recovered",
	"silence_cleared",
];
void _statusCheck;
