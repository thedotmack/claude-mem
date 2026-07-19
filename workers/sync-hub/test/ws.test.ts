/**
 * Advisory WebSocket suite (plan Phase 4 verification). SEPARATE vitest
 * invocation (`npm run test:ws` → `--maxWorkers=1 --no-isolate`): the
 * documented pool-workers limitation makes WS + DO tests flaky under the
 * default isolation, so this file is excluded from `npm test` and run alone.
 *
 * Covers:
 *   - upgrade 101 (and 426 for non-upgrade, at both the Worker and the DO)
 *   - auth enforced on /v1/sync/ws exactly like the HTTP routes
 *   - fan-out reaches other-device sockets and EXCLUDES the origin device
 *   - frame shape: {type:'op', epoch, ops:[ChangeOp...]} with committed ops
 *   - advance fallback for big pushes (>100 ops, or >256 KiB serialized)
 *   - replayed (fully duplicate) pushes fan out nothing
 *   - hibernation survival: evictDurableObject({webSockets:'hibernate'})
 *     then a push → attachment-restored delivery
 *   - a dead socket never fails pushOps (the push is durable, the socket is
 *     advisory)
 *   - app-level ping → pong auto-response
 *   - kill switch (Phase 5): tripped ⇒ upgrade refused 503/poll at the
 *     front Worker; cleared ⇒ upgrades succeed again (recovery)
 */

import { env, evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PushOp, PushOutcome, PushResult } from "../src/do/SyncHub";
import { KILL_SWITCH_KEY } from "../src/kill-switch";

const base = "https://sync-hub.test";

interface OpFrame {
	type: "op";
	epoch: string;
	ops: Array<{
		seq: number;
		kind: string;
		origin_device: string;
		origin_id: string;
		rev: number;
		body: string;
		server_ts: number;
	}>;
}

interface AdvanceFrame {
	type: "advance";
	epoch: string;
	head_seq: number;
}

function headers(userId: string, deviceId: string): Record<string, string> {
	return {
		Authorization: `Bearer valid-for:${userId}`,
		"X-User-Id": userId,
		"X-Device-Id": deviceId,
	};
}

function rowOp(originId: string, rev = 1, body?: string): PushOp {
	return {
		kind: "observation",
		origin_id: originId,
		rev,
		body: body ?? JSON.stringify({ title: `obs ${originId}`, rev }),
	};
}

/** Unwrap a successful push; fails the test on an unexpected refusal. */
function ok(outcome: PushOutcome): PushResult {
	if ("refused" in outcome) {
		throw new Error(`unexpected refusal: ${outcome.error}`);
	}
	return outcome;
}

interface Connected {
	ws: WebSocket;
	messages: string[];
}

/** Upgrade a client socket through the front Worker (the real auth path). */
async function connect(userId: string, deviceId: string): Promise<Connected> {
	const res = await SELF.fetch(`${base}/v1/sync/ws`, {
		headers: { ...headers(userId, deviceId), Upgrade: "websocket" },
	});
	expect(res.status).toBe(101);
	const ws = res.webSocket;
	expect(ws).not.toBeNull();
	const messages: string[] = [];
	ws!.accept();
	ws!.addEventListener("message", (event) => {
		messages.push(String(event.data));
	});
	return { ws: ws!, messages };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe("upgrade + auth", () => {
	it("upgrades an authenticated request to 101", async () => {
		const { ws } = await connect("user-ws-upgrade", "dev-a");
		ws.close();
	});

	it("426s a non-upgrade request at the front Worker", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/ws`, {
			headers: headers("user-ws-426", "dev-a"),
		});
		expect(res.status).toBe(426);
	});

	it("426s a non-upgrade request at the DO itself", async () => {
		// Direct stub.fetch without the Upgrade header — the DO's own guard.
		const stub = env.SYNC_HUB.getByName("user-ws-do-426");
		const res = await stub.fetch(
			new Request(`${base}/v1/sync/ws`, {
				headers: { "X-Device-Id": "dev-a" },
			}),
		);
		expect(res.status).toBe(426);
	});

	it("401s an upgrade without credentials", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/ws`, {
			headers: { Upgrade: "websocket" },
		});
		expect(res.status).toBe(401);
	});

	it("403s an upgrade whose token belongs to a different user", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/ws`, {
			headers: {
				Authorization: "Bearer wrong-user",
				"X-User-Id": "victim-user-ws",
				"X-Device-Id": "dev-a",
				Upgrade: "websocket",
			},
		});
		expect(res.status).toBe(403);
	});

	it("400s an upgrade without a device id", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/ws`, {
			headers: {
				Authorization: "Bearer valid-for:user-ws-nodev",
				"X-User-Id": "user-ws-nodev",
				Upgrade: "websocket",
			},
		});
		expect(res.status).toBe(400);
	});

	it("answers app-level ping with pong without involving the DO handlers", async () => {
		const { ws, messages } = await connect("user-ws-ping", "dev-a");
		ws.send("ping");
		await waitFor(() => messages.includes("pong"), "auto-response pong");
		ws.close();
	});
});

describe("fan-out", () => {
	it("delivers committed ops to other-device sockets and EXCLUDES the origin device", async () => {
		const user = "user-ws-fanout";
		const origin = await connect(user, "dev-a");
		const replicaB = await connect(user, "dev-b");
		const replicaC = await connect(user, "dev-c");

		const push = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers(user, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ ops: [rowOp("1"), rowOp("2")] }),
		});
		expect(push.status).toBe(200);
		const acked = ((await push.json()) as { acked: { seq: number }[] }).acked;

		await waitFor(
			() => replicaB.messages.length >= 1 && replicaC.messages.length >= 1,
			"frames on both replicas",
		);
		for (const replica of [replicaB, replicaC]) {
			const frame = JSON.parse(replica.messages[0]) as OpFrame;
			expect(frame.type).toBe("op");
			expect(typeof frame.epoch).toBe("string");
			expect(frame.ops).toHaveLength(2);
			expect(frame.ops.map((op) => op.seq)).toEqual(acked.map((a) => a.seq));
			// Full canonical ChangeOp shape — the client feeds these straight
			// into the same applyOps path as HTTP pulls.
			expect(frame.ops[0]).toMatchObject({
				kind: "observation",
				origin_device: "dev-a",
				origin_id: "1",
				rev: 1,
			});
			expect(typeof frame.ops[0].body).toBe("string");
			expect(typeof frame.ops[0].server_ts).toBe("number");
		}

		// The origin device must NOT receive its own echo.
		await settle();
		expect(origin.messages).toHaveLength(0);

		origin.ws.close();
		replicaB.ws.close();
		replicaC.ws.close();
	});

	it("falls back to {type:'advance'} when a push exceeds 100 ops", async () => {
		const user = "user-ws-advance-count";
		const replica = await connect(user, "dev-b");

		const ops = Array.from({ length: 101 }, (_, i) => rowOp(`big-${i}`));
		const stub = env.SYNC_HUB.getByName(user);
		const result = ok(await stub.pushOps("dev-a", ops));

		await waitFor(() => replica.messages.length >= 1, "advance frame");
		const frame = JSON.parse(replica.messages[0]) as AdvanceFrame;
		expect(frame.type).toBe("advance");
		expect(frame.head_seq).toBe(result.head_seq);
		expect(typeof frame.epoch).toBe("string");
		replica.ws.close();
	});

	it("falls back to {type:'advance'} when the pushed bodies exceed the byte budget (≤100 ops)", async () => {
		const user = "user-ws-advance-bytes";
		const replica = await connect(user, "dev-b");

		// 3 ops x ~100 KB bodies ≈ 300 KB > the 256 KiB frame budget, while
		// staying far under the per-op and request caps. The SUM(LENGTH(body))
		// pre-gate must divert to advance WITHOUT materializing the rows.
		const fatBody = JSON.stringify({ blob: "x".repeat(100_000) });
		const ops = [rowOp("fat-1", 1, fatBody), rowOp("fat-2", 1, fatBody), rowOp("fat-3", 1, fatBody)];
		const stub = env.SYNC_HUB.getByName(user);
		const result = ok(await stub.pushOps("dev-a", ops));
		expect(result.acked).toHaveLength(3); // the push itself is unaffected

		await waitFor(() => replica.messages.length >= 1, "advance frame");
		await settle();
		// Exactly one frame, and it is an advance — never an op frame.
		expect(replica.messages).toHaveLength(1);
		const frame = JSON.parse(replica.messages[0]) as AdvanceFrame;
		expect(frame.type).toBe("advance");
		expect(frame.head_seq).toBe(result.head_seq);
		replica.ws.close();
	});

	it("survives a near-cap fat batch (4 x ~1.9 MB bodies): acks + advance, no OOM-sized op frame", async () => {
		// The remotely-reachable worst case the pre-gate exists for: a handful
		// of per-op-cap bodies that individually pass validation but together
		// would serialize a multi-MB frame if materialized.
		const user = "user-ws-advance-huge";
		const replica = await connect(user, "dev-b");

		const hugeBody = "x".repeat(1_900_000);
		const ops = Array.from({ length: 4 }, (_, i) => rowOp(`huge-${i}`, 1, hugeBody));
		const stub = env.SYNC_HUB.getByName(user);
		const result = ok(await stub.pushOps("dev-a", ops));
		expect(result.acked).toHaveLength(4);

		await waitFor(() => replica.messages.length >= 1, "advance frame");
		await settle();
		expect(replica.messages).toHaveLength(1);
		const frame = JSON.parse(replica.messages[0]) as AdvanceFrame;
		expect(frame.type).toBe("advance");
		expect(frame.head_seq).toBe(result.head_seq);
		replica.ws.close();
	});

	it("fans out nothing for a fully-replayed (duplicate) push", async () => {
		const user = "user-ws-replay";
		const stub = env.SYNC_HUB.getByName(user);
		ok(await stub.pushOps("dev-a", [rowOp("r1")]));

		const replica = await connect(user, "dev-b");
		ok(await stub.pushOps("dev-a", [rowOp("r1")])); // pure replay
		await settle();
		expect(replica.messages).toHaveLength(0);

		// ...and a genuinely new op right after still arrives (the baseline
		// bookkeeping did not wedge).
		ok(await stub.pushOps("dev-a", [rowOp("r2")]));
		await waitFor(() => replica.messages.length >= 1, "frame for the new op");
		const frame = JSON.parse(replica.messages[0]) as OpFrame;
		expect(frame.type).toBe("op");
		expect(frame.ops.map((op) => op.origin_id)).toEqual(["r2"]);
		replica.ws.close();
	});

	it("survives hibernation: eviction + push → attachment-restored delivery, origin still excluded", async () => {
		const user = "user-ws-hibernate";
		const origin = await connect(user, "dev-a");
		const replica = await connect(user, "dev-b");
		const stub = env.SYNC_HUB.getByName(user);

		// Evict the DO instance while keeping the sockets open (hibernation).
		// The next push recreates the instance; device identity must come back
		// from the serialized attachments alone.
		await evictDurableObject(stub, { webSockets: "hibernate" });

		ok(await stub.pushOps("dev-a", [rowOp("h1")]));
		await waitFor(() => replica.messages.length >= 1, "post-hibernation frame");
		const frame = JSON.parse(replica.messages[0]) as OpFrame;
		expect(frame.type).toBe("op");
		expect(frame.ops.map((op) => op.origin_id)).toEqual(["h1"]);

		await settle();
		expect(origin.messages).toHaveLength(0);
		origin.ws.close();
		replica.ws.close();
	});

	it("a dead socket never fails pushOps", async () => {
		const user = "user-ws-dead-socket";
		const replica = await connect(user, "dev-b");
		replica.ws.close();

		const stub = env.SYNC_HUB.getByName(user);
		const result = ok(await stub.pushOps("dev-a", [rowOp("d1")]));
		expect(result.acked).toHaveLength(1);

		// The durable lane is untouched: a fresh reader sees the op.
		const changes = await stub.getChanges("dev-c", 0, 500);
		expect(changes.ops.map((op) => op.origin_id)).toEqual(["d1"]);
	});
});

describe("kill switch × upgrade (plan Phase 5 task 2)", () => {
	it("refuses upgrades 503/poll while tripped, then upgrades again after clear (recovery)", async () => {
		// This suite runs --no-isolate, so the flag MUST be cleaned up even on
		// assertion failure — the finally guards every later test.
		await env.AUTH_CACHE.put(KILL_SWITCH_KEY, JSON.stringify({ source: "ws-test" }));
		try {
			const refused = await SELF.fetch(`${base}/v1/sync/ws`, {
				headers: { ...headers("user-ws-kill", "dev-a"), Upgrade: "websocket" },
			});
			expect(refused.status).toBe(503);
			expect(refused.headers.get("X-Sync-Mode")).toBe("poll");
			const body = (await refused.json()) as { mode: string };
			expect(body.mode).toBe("poll");
		} finally {
			await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
		}

		// Cleared ⇒ the very next upgrade succeeds (KILL_SWITCH_CACHE_MS=0
		// in the test bindings) and fan-out works as usual.
		const { ws } = await connect("user-ws-kill", "dev-a");
		ws.close();
	});
});
