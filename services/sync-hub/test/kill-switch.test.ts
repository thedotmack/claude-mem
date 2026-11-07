/**
 * Kill-switch suite (plan Phase 5 task 2 verification).
 *
 * Hypothesis under test (PLAN.md): the 1% Workers Logs sample cut is not
 * customer pain. #4140 `skipProjectionDrain` on the push path left
 * head_seq ahead of projected_seq; clients reject that 200
 * (`head_seq <= projected_seq`). These tests keep kill-switch ON and still
 * require a 200 to cover head — logging config is not touched.
 *
 * SELF tests run with KILL_SWITCH_CACHE_MS=0 (vitest.config.ts) so a KV
 * flag flip is visible on the very next request:
 *   - tripped ⇒ /v1/sync/ops and /v1/sync/changes STILL WORK (the
 *     structural guarantee: poll mode degrades socket latency, never
 *     correctness) but carry `X-Sync-Mode: poll`; pushes still drain
 *     projection so a 200 satisfies head_seq <= projected_seq (clients
 *     reject a lagged 200); repair drain remains for leftover catch-up;
 *     /v1/sync/status too; the WS upgrade is refused with 503 + a JSON body
 *     clients recognize ({mode: "poll"}) — built in the front Worker, the
 *     DO is never woken.
 *   - cleared ⇒ no header, normal behavior.
 *   - ANY value at the key counts as tripped (presence contract — a
 *     hand-typed emergency `wrangler kv key put ... "1"` works).
 *
 * Unit tests cover the per-isolate read cache (the documented KV-read-cost
 * vs freshness trade) and the fail-closed contract via an injected fake KV.
 */

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetKillSwitchCacheForTests,
	KILL_SWITCH_KEY,
	readKillSwitch,
	SYNC_MODE_HEADER,
	SYNC_MODE_POLL,
	tripKillSwitch,
} from "../src/kill-switch";
import { POLL_PUSH_DRAIN_MAX_PAGES } from "../src/index";
import { PROJECTION_PAGE_MAX_OPS } from "../src/projection-protocol";
import { observationOp } from "./content-v2-helpers";

const base = "https://sync-hub.test";

function headers(userId: string, deviceId = "dev-ks"): Record<string, string> {
	return {
		Authorization: `Bearer valid-for:${userId}`,
		"X-User-Id": userId,
		"X-Device-Id": deviceId,
	};
}

async function trip(value = JSON.stringify({ source: "test" })): Promise<void> {
	await env.AUTH_CACHE.put(KILL_SWITCH_KEY, value);
}

beforeEach(() => {
	__resetKillSwitchCacheForTests();
});

afterEach(async () => {
	__resetKillSwitchCacheForTests();
	await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
});

describe("kill switch: front Worker behavior", () => {
	it("tripped ⇒ pushes still succeed AND carry X-Sync-Mode: poll", async () => {
		await trip();
		const op = await observationOp("1", "1", "dev-ks");
		const res = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers("user-ks-push"), "Content-Type": "application/json" },
			body: JSON.stringify({
				protocol_version: 2,
				ops: [op],
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
		const body = (await res.json()) as { acked: unknown[]; head_seq: string; projected_seq: string };
		expect(body.acked).toHaveLength(1); // the durable lane is untouched
		// skipProjectionDrain used to return 200 with projected_seq "0" here.
		// That is the customer pain — not the log sample. Clients cannot flush
		// unless this 200 already satisfies head_seq <= projected_seq.
		expect(body.projected_seq).toBe(body.head_seq);
		expect(body.projected_seq).toBe("1");

		const repair = await SELF.fetch(`${base}/internal/v1/projection/drain`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-projector-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ protocol_version: 1, user_id: "user-ks-push" }),
		});
		expect(repair.status).toBe(200);
		expect(await repair.json()).toMatchObject({
			head_seq: "1",
			projected_through_seq: "1",
		});
	});

	it("tripped ⇒ sequential pushes keep head_seq <= projected_seq (lag cannot re-grow)", async () => {
		await trip();
		const user = "user-ks-pace";
		for (const origin of ["1", "2", "3"]) {
			const op = await observationOp(origin, "1", "dev-ks");
			const res = await SELF.fetch(`${base}/v1/sync/ops`, {
				method: "POST",
				headers: { ...headers(user), "Content-Type": "application/json" },
				body: JSON.stringify({ protocol_version: 2, ops: [op] }),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
			const body = (await res.json()) as { head_seq: string; projected_seq: string };
			expect(body.projected_seq).toBe(body.head_seq);
			expect(body.head_seq).toBe(origin);
		}
	});

	it("tripped ⇒ a pre-existing lag larger than the poll-mode page budget still reaches head<=projected", async () => {
		await trip();
		const user = "user-ks-backlog";
		const stub = env.SYNC_HUB.getByName(user);
		const lagged = POLL_PUSH_DRAIN_MAX_PAGES * PROJECTION_PAGE_MAX_OPS;
		// Seed Hub head without projecting — the #4140 skip shape (head ahead,
		// projected_seq still 0). Worker HTTP is capped at 500 ops/push, so
		// this goes through the DO RPC the same way a skipped drain left state.
		for (let start = 1; start <= lagged; start += 400) {
			const count = Math.min(400, lagged - start + 1);
			const seed = await Promise.all(
				Array.from({ length: count }, (_, index) => observationOp(String(start + index), "1", "dev-ks")),
			);
			const seeded = await stub.pushOps("dev-ks", seed, null);
			if ("refused" in seeded) throw new Error(seeded.error);
		}
		const seededState = await stub.getProjectionState();
		expect(seededState.head_seq).toBe(String(lagged));
		expect(seededState.projected_seq).toBe("0");

		const next = await observationOp(String(lagged + 1), "1", "dev-ks");
		const request = () => SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers(user), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [next] }),
		});

		const first = await request();
		expect(first.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
		const firstBody = (await first.json()) as {
			error?: string;
			durable?: boolean;
			retryable?: boolean;
			head_seq: string;
			projected_seq: string;
		};
		expect(first.status).toBe(503);
		expect(firstBody).toMatchObject({
			error: "projection_catching_up",
			durable: true,
			retryable: true,
			head_seq: String(lagged + 1),
			projected_seq: String(lagged),
		});

		let lastStatus = first.status;
		let lastBody = firstBody;
		for (let attempt = 0; attempt < 5 && lastStatus !== 200; attempt++) {
			const retry = await request();
			lastStatus = retry.status;
			lastBody = (await retry.json()) as typeof firstBody;
			expect(retry.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
		}
		expect(lastStatus).toBe(200);
		expect(lastBody.projected_seq).toBe(lastBody.head_seq);
		expect(lastBody.head_seq).toBe(String(lagged + 1));
	});

	it("tripped ⇒ a bounded inline catch-up does not continue in the background", async () => {
		await trip();
		const user = "user-ks-no-waituntil";
		const stub = env.SYNC_HUB.getByName(user);
		const lagged = POLL_PUSH_DRAIN_MAX_PAGES * PROJECTION_PAGE_MAX_OPS;
		for (let start = 1; start <= lagged; start += 400) {
			const count = Math.min(400, lagged - start + 1);
			const seed = await Promise.all(
				Array.from({ length: count }, (_, index) => observationOp(String(start + index), "1", "dev-ks")),
			);
			const seeded = await stub.pushOps("dev-ks", seed, null);
			if ("refused" in seeded) throw new Error(seeded.error);
		}

		const next = await observationOp(String(lagged + 1), "1", "dev-ks");
		const first = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers(user), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [next] }),
		});
		expect(first.status).toBe(503);
		expect(await first.json()).toMatchObject({
			error: "projection_catching_up",
			projected_seq: String(lagged),
			head_seq: String(lagged + 1),
		});

		await new Promise((resolve) => setTimeout(resolve, 250));
		const state = await stub.getProjectionState();
		expect(state.projected_seq).toBe(String(lagged));
		expect(state.head_seq).toBe(String(lagged + 1));
	});

	it("tripped ⇒ pulls still succeed AND carry X-Sync-Mode: poll (poll-path convergence intact)", async () => {
		const user = "user-ks-pull";
		// Seed one op while tripped — write path must be unaffected.
		await trip();
		const op = await observationOp("10", "1", "dev-a");
		const push = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers(user, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({
				protocol_version: 2,
				ops: [op],
			}),
		});
		expect(push.status).toBe(200);

		const pull = await SELF.fetch(`${base}/v1/sync/changes?since=0`, {
			headers: headers(user, "dev-b"),
		});
		expect(pull.status).toBe(200);
		expect(pull.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
		const page = (await pull.json()) as { ops: Array<{ body: string }> };
		expect(page.ops.map((change) => JSON.parse(change.body).origin_local_id)).toEqual(["10"]);
	});

	it("tripped ⇒ /v1/sync/status carries the header too", async () => {
		await trip();
		const res = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: headers("user-ks-status"),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
	});

	it("tripped ⇒ WS upgrade refused: 503 + recognizable JSON body + header, before the DO is woken", async () => {
		await trip();
		const res = await SELF.fetch(`${base}/v1/sync/ws`, {
			headers: { ...headers("user-ks-ws"), Upgrade: "websocket" },
		});
		expect(res.status).toBe(503);
		expect(res.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
		const body = (await res.json()) as { error: string; mode: string };
		expect(body.mode).toBe(SYNC_MODE_POLL);
		expect(body.error).toContain("poll mode");
	});

	it("cleared ⇒ responses lose the header and behave normally", async () => {
		await trip();
		const tripped = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: headers("user-ks-clear"),
		});
		expect(tripped.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);

		await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
		const clear = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: headers("user-ks-clear"),
		});
		expect(clear.status).toBe(200);
		expect(clear.headers.get(SYNC_MODE_HEADER)).toBeNull();
	});

	it("ANY value at the key counts as tripped (hand-typed emergency put)", async () => {
		await trip("1");
		const res = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: headers("user-ks-any"),
		});
		expect(res.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
	});

	it("error responses carry the header too while tripped (the header is the only mode signal)", async () => {
		await trip();
		const res = await SELF.fetch(`${base}/v1/sync/changes?since=-1`, {
			headers: headers("user-ks-err"),
		});
		expect(res.status).toBe(400);
		expect(res.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
	});

	it("AUTH-FAILURE responses carry the header while tripped (correlated-incident guard)", async () => {
		// Incidents correlate: a tripped switch during a degraded verify
		// upstream must not produce unstamped errors — clients treat header
		// absence on an OK response as "cleared", so an unstamped auth error
		// stream would be the one signal they never see.
		await trip();

		// Verify upstream rejects the token → 401 from authenticate.
		const denied = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: {
				Authorization: "Bearer denied-401",
				"X-User-Id": "user-ks-auth-denied",
				"X-Device-Id": "dev-ks",
			},
		});
		expect(denied.status).toBe(401);
		expect(denied.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);

		// Verify upstream is DOWN → fail-closed 503 from authenticate — the
		// exact correlated-incident shape.
		const unreachable = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: {
				Authorization: "Bearer upstream-500",
				"X-User-Id": "user-ks-auth-down",
				"X-Device-Id": "dev-ks",
			},
		});
		expect(unreachable.status).toBe(503);
		expect(unreachable.headers.get(SYNC_MODE_HEADER)).toBe(SYNC_MODE_POLL);
	});
});

describe("kill switch: per-isolate cache + fail-closed (unit)", () => {
	interface FakeKV {
		reads: number;
		value: string | null;
		throwOnGet: boolean;
	}

	function fakeEnv(kv: FakeKV, cacheMs: string): Env {
		return {
			...env,
			KILL_SWITCH_CACHE_MS: cacheMs,
			AUTH_CACHE: {
				get: async (_key: string) => {
					kv.reads++;
					if (kv.throwOnGet) throw new Error("simulated KV outage");
					return kv.value;
				},
			} as unknown as KVNamespace,
		} as Env;
	}

	it("caches the verdict per isolate for KILL_SWITCH_CACHE_MS", async () => {
		const kv: FakeKV = { reads: 0, value: "flag", throwOnGet: false };
		const testEnv = fakeEnv(kv, "30000");
		let nowMs = 1_000_000;
		const now = () => nowMs;

		expect((await readKillSwitch(testEnv, { now })).tripped).toBe(true);
		expect(kv.reads).toBe(1);
		// Within the TTL: served from the isolate cache, no second KV read.
		nowMs += 29_999;
		expect((await readKillSwitch(testEnv, { now })).tripped).toBe(true);
		expect(kv.reads).toBe(1);
		// Past the TTL: re-read (and observe a clear).
		nowMs += 2;
		kv.value = null;
		expect((await readKillSwitch(testEnv, { now })).tripped).toBe(false);
		expect(kv.reads).toBe(2);
	});

	it("KILL_SWITCH_CACHE_MS=0 reads per request", async () => {
		const kv: FakeKV = { reads: 0, value: null, throwOnGet: false };
		const testEnv = fakeEnv(kv, "0");
		await readKillSwitch(testEnv);
		await readKillSwitch(testEnv);
		expect(kv.reads).toBe(2);
	});

	it("KV get throws means ON", async () => {
		const kv: FakeKV = { reads: 0, value: null, throwOnGet: true };
		const testEnv = fakeEnv(kv, "0");
		expect((await readKillSwitch(testEnv)).tripped).toBe(true);
		expect(kv.reads).toBe(1);
	});

	it("KV get returns null means OFF", async () => {
		const kv: FakeKV = { reads: 0, value: null, throwOnGet: false };
		const testEnv = fakeEnv(kv, "0");
		const state = await readKillSwitch(testEnv);
		expect(state.tripped).toBe(false);
		expect(state.raw).toBeNull();
		expect(kv.reads).toBe(1);
	});

	it("KV get returns a value means ON", async () => {
		const kv: FakeKV = { reads: 0, value: "1", throwOnGet: false };
		const testEnv = fakeEnv(kv, "0");
		const state = await readKillSwitch(testEnv);
		expect(state.tripped).toBe(true);
		expect(state.raw).toBe("1");
		expect(kv.reads).toBe(1);
	});

	it("fails CLOSED on a KV read error and does not cache the failure", async () => {
		const kv: FakeKV = { reads: 0, value: "flag", throwOnGet: true };
		const testEnv = fakeEnv(kv, "30000");
		expect((await readKillSwitch(testEnv)).tripped).toBe(true);
		// KV recovers: the very next read sees the flag (failure never cached).
		kv.throwOnGet = false;
		expect((await readKillSwitch(testEnv)).tripped).toBe(true);
		expect(kv.reads).toBe(2);
	});

	it("keeps the last known value when a later KV read fails", async () => {
		const kv: FakeKV = { reads: 0, value: null, throwOnGet: false };
		const testEnv = fakeEnv(kv, "30000");
		let nowMs = 1_000_000;
		expect((await readKillSwitch(testEnv, { now: () => nowMs })).tripped).toBe(false);

		kv.throwOnGet = true;
		nowMs += 30_001;
		expect((await readKillSwitch(testEnv, { now: () => nowMs })).tripped).toBe(false);
		expect(kv.reads).toBe(2);
	});

	it("logs a KV read failure once per isolate", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const kv: FakeKV = { reads: 0, value: null, throwOnGet: true };
		const testEnv = fakeEnv(kv, "0");
		expect((await readKillSwitch(testEnv)).tripped).toBe(true);
		expect((await readKillSwitch(testEnv)).tripped).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(String(spy.mock.calls[0]?.[0])).toContain("failing closed");
		spy.mockRestore();
	});

	it("tripKillSwitch writes a JSON flag once and reports already_tripped after", async () => {
		const first = await tripKillSwitch(env as Env, { source: "unit", detail: 1 });
		expect(first.alreadyTripped).toBe(false);
		const raw = await env.AUTH_CACHE.get(KILL_SWITCH_KEY);
		const flag = JSON.parse(raw!) as { source: string; tripped_at: string };
		expect(flag.source).toBe("unit");
		expect(typeof flag.tripped_at).toBe("string");

		const second = await tripKillSwitch(env as Env, { source: "unit" });
		expect(second.alreadyTripped).toBe(true);
		expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).toBe(raw);
	});
});
