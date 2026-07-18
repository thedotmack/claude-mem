/**
 * SyncHub Durable Object tests (plan Phase 1 verification):
 *   - push idempotency (same op twice → same seq)
 *   - cursor pagination (600 ops → 2 pages with `more` flag)
 *   - rev supersession
 *   - chunked-insert correctness at the 100-bound-param boundary
 *   - compaction alarm via runDurableObjectAlarm
 *   - mutation-op validation (refuse unparseable remap_project)
 *   - front-Worker HTTP round-trip via SELF (DEV_ALLOW_ANY_TOKEN binding)
 *
 * Each test targets its own user (getByName isolation) so state never bleeds.
 */

import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PushOp, PushOutcome, PushResult, SyncHub } from "../src/do/SyncHub";

function hub(userId: string) {
	return env.SYNC_HUB.getByName(userId);
}

/** Unwrap a successful push; fails the test on an unexpected refusal. */
function ok(outcome: PushOutcome): PushResult {
	if ("refused" in outcome) {
		throw new Error(`unexpected refusal: ${outcome.error}`);
	}
	return outcome;
}

/** Assert a push was refused with a message matching `pattern`. */
function expectRefusal(outcome: PushOutcome, pattern: RegExp): void {
	expect(outcome).toHaveProperty("refused", true);
	expect((outcome as { error: string }).error).toMatch(pattern);
}

function rowOp(originId: string, rev = 1, extra: Record<string, unknown> = {}): PushOp {
	return {
		kind: "observation",
		origin_id: originId,
		rev,
		body: JSON.stringify({ title: `obs ${originId}`, rev, ...extra }),
	};
}

describe("pushOps", () => {
	it("is idempotent: pushing the same op twice returns the same seq", async () => {
		const stub = hub("user-idempotency");
		const ops = [rowOp("1")];

		const first = ok(await stub.pushOps("dev-a", ops));
		expect(first.acked).toHaveLength(1);
		const seq = first.acked[0].seq;
		expect(seq).toBeGreaterThan(0);

		const second = ok(await stub.pushOps("dev-a", ops));
		expect(second.acked).toHaveLength(1);
		expect(second.acked[0].seq).toBe(seq);
		expect(second.head_seq).toBe(first.head_seq);

		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT COUNT(*) AS n FROM ops")
				.toArray();
			expect(rows[0].n).toBe(1);
		});
	});

	it("keeps the first write on duplicate push (body is not overwritten)", async () => {
		const stub = hub("user-first-write-wins");
		ok(
			await stub.pushOps("dev-a", [
				{ kind: "observation", origin_id: "9", rev: 1, body: '{"v":"original"}' },
			]),
		);
		ok(
			await stub.pushOps("dev-a", [
				{ kind: "observation", origin_id: "9", rev: 1, body: '{"v":"replayed"}' },
			]),
		);
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT body FROM ops WHERE origin_id = '9'")
				.toArray();
			expect(rows).toHaveLength(1);
			expect(rows[0].body).toBe('{"v":"original"}');
		});
	});

	it("chunks multi-row inserts correctly at the 100-bound-param boundary", async () => {
		const stub = hub("user-chunking");
		// 6 params per row → 16 rows fit one statement; 17 forces a second
		// chunk; 100 exercises several. All must ack with distinct seqs.
		for (const [device, count] of [
			["dev-16", 16],
			["dev-17", 17],
			["dev-100", 100],
		] as const) {
			const ops = Array.from({ length: count }, (_, i) => rowOp(`${device}-${i}`));
			const result = ok(await stub.pushOps(device, ops));
			expect(result.acked).toHaveLength(count);
			const seqs = new Set(result.acked.map((a) => a.seq));
			expect(seqs.size).toBe(count);
			for (const op of ops) {
				expect(result.acked.some((a) => a.origin_id === op.origin_id)).toBe(true);
			}
		}
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT COUNT(*) AS n FROM ops")
				.toArray();
			expect(rows[0].n).toBe(16 + 17 + 100);
		});
	});

	it("a duplicate inside a larger batch acks the original seq", async () => {
		const stub = hub("user-partial-dup");
		const first = ok(await stub.pushOps("dev-a", [rowOp("1"), rowOp("2")]));
		const seqOf = (r: PushResult, id: string) =>
			r.acked.find((a) => a.origin_id === id)!.seq;

		const second = ok(await stub.pushOps("dev-a", [rowOp("2"), rowOp("3")]));
		expect(seqOf(second, "2")).toBe(seqOf(first, "2"));
		expect(seqOf(second, "3")).toBeGreaterThan(first.head_seq);
	});

	it("stores distinct revs of the same entity as distinct log entries", async () => {
		const stub = hub("user-revs");
		const r1 = ok(await stub.pushOps("dev-a", [rowOp("42", 1)]));
		const r2 = ok(await stub.pushOps("dev-a", [rowOp("42", 2)]));
		expect(r2.acked[0].seq).toBeGreaterThan(r1.acked[0].seq);

		// Replaying the superseded rev still acks its original seq.
		const replay = ok(await stub.pushOps("dev-a", [rowOp("42", 1)]));
		expect(replay.acked[0].seq).toBe(r1.acked[0].seq);

		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT rev FROM ops WHERE origin_id = '42' ORDER BY rev")
				.toArray();
			expect(rows.map((r) => r.rev)).toEqual([1, 2]);
		});
	});

	it("enforces the per-op body backstop at 1,990,000 bytes (docs: 2 MB row = 2,000,000 bytes, minus sibling-column headroom)", async () => {
		const stub = hub("user-body-cap");
		expectRefusal(
			await stub.pushOps("dev-a", [
				{ kind: "observation", origin_id: "1", body: "x".repeat(1_990_001) },
			]),
			/invalid_ops/,
		);
		// Exactly at the cap is accepted — and being under the SQLite row
		// limit, it must store rather than explode.
		const atCap = ok(
			await stub.pushOps("dev-a", [
				{ kind: "observation", origin_id: "2", body: "x".repeat(1_990_000) },
			]),
		);
		expect(atCap.acked).toHaveLength(1);
	});

	it("refuses the whole batch when any op is invalid", async () => {
		const stub = hub("user-batch-refusal");
		expectRefusal(
			await stub.pushOps("dev-a", [
				rowOp("1"),
				{ kind: "bogus" as never, origin_id: "2", body: "{}" },
			]),
			/invalid_ops/,
		);
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT COUNT(*) AS n FROM ops")
				.toArray();
			expect(rows[0].n).toBe(0);
		});
	});
});

describe("mutation ops", () => {
	it("accepts parseable mutation envelopes (storage only)", async () => {
		const stub = hub("user-mutations");
		const result = ok(
			await stub.pushOps("dev-a", [
				{
					kind: "mutation",
					origin_id: "b3b9d7b0-0000-4000-8000-000000000001",
					body: JSON.stringify({
						op: "set_title",
						target: { table: "sdk_sessions", origin_id: "12" },
						fields: { custom_title: "renamed" },
					}),
				},
				{
					kind: "mutation",
					origin_id: "b3b9d7b0-0000-4000-8000-000000000002",
					body: JSON.stringify({
						op: "remap_project",
						where: { project: "old-name" },
						fields: { project: "new-name" },
					}),
				},
			]),
		);
		expect(result.acked).toHaveLength(2);
	});

	it("refuses unparseable mutation bodies", async () => {
		const stub = hub("user-bad-mutation");
		expectRefusal(
			await stub.pushOps("dev-a", [
				{
					kind: "mutation",
					origin_id: "b3b9d7b0-0000-4000-8000-000000000003",
					body: "this is not json",
				},
			]),
			/not parseable JSON/,
		);
	});

	it("refuses remap_project ops without a parseable where predicate", async () => {
		const stub = hub("user-bad-remap");
		expectRefusal(
			await stub.pushOps("dev-a", [
				{
					kind: "mutation",
					origin_id: "b3b9d7b0-0000-4000-8000-000000000004",
					body: JSON.stringify({
						op: "remap_project",
						where: "project = old", // string, not a structured predicate
						fields: { project: "new" },
					}),
				},
			]),
			/remap_project requires a parseable where predicate/,
		);
	});
});

describe("getChanges", () => {
	it("paginates 600 ops into two pages with the more flag", async () => {
		const stub = hub("user-pagination");
		// Push 600 ops in a few batches (also exercises chunked inserts).
		for (let batch = 0; batch < 3; batch++) {
			const ops = Array.from({ length: 200 }, (_, i) =>
				rowOp(`${batch * 200 + i}`),
			);
			ok(await stub.pushOps("dev-writer", ops));
		}

		const page1 = await stub.getChanges("dev-reader", 0, 500);
		expect(page1.ops).toHaveLength(500);
		expect(page1.more).toBe(true);
		expect(page1.epoch).toBeTruthy();
		// Strictly increasing seq within the page.
		for (let i = 1; i < page1.ops.length; i++) {
			expect(page1.ops[i].seq).toBeGreaterThan(page1.ops[i - 1].seq);
		}

		const cursor = page1.ops[page1.ops.length - 1].seq;
		const page2 = await stub.getChanges("dev-reader", cursor, 500);
		expect(page2.ops).toHaveLength(100);
		expect(page2.more).toBe(false);
		expect(page2.head_seq).toBe(page2.ops[page2.ops.length - 1].seq);
		expect(page2.epoch).toBe(page1.epoch);

		// No overlap, no gap.
		expect(page2.ops[0].seq).toBeGreaterThan(cursor);
		const total = new Set([...page1.ops, ...page2.ops].map((op) => op.seq));
		expect(total.size).toBe(600);
	});

	it("clamps limit to 500", async () => {
		const stub = hub("user-limit-clamp");
		const ops = Array.from({ length: 501 }, (_, i) => rowOp(`${i}`));
		ok(await stub.pushOps("dev-writer", ops));
		const page = await stub.getChanges("dev-reader", 0, 10_000);
		expect(page.ops).toHaveLength(500);
		expect(page.more).toBe(true);
	});

	it("records the presented cursor as the device ack watermark", async () => {
		const stub = hub("user-ack-tracking");
		const push = ok(await stub.pushOps("dev-writer", [rowOp("1"), rowOp("2")]));
		await stub.getChanges("dev-reader", push.head_seq, 500);
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec(
					"SELECT last_ack_seq FROM devices WHERE device_id = 'dev-reader'",
				)
				.toArray();
			expect(rows[0].last_ack_seq).toBe(push.head_seq);
		});
	});
});

describe("compaction alarm", () => {
	it("is scheduled by the constructor and reschedules itself after running", async () => {
		const stub = hub("user-alarm-scheduling");
		await stub.getStatus(); // wake the DO so the constructor runs
		await runInDurableObject(stub, async (_instance: SyncHub, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
		});

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		await runInDurableObject(stub, async (_instance: SyncHub, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
		});
	});

	it("deletes superseded revs below the fleet ack watermark", async () => {
		const stub = hub("user-compaction");
		ok(await stub.pushOps("dev-a", [rowOp("7", 1)]));
		const r2 = ok(await stub.pushOps("dev-a", [rowOp("7", 2)]));
		ok(await stub.pushOps("dev-a", [rowOp("8", 1)])); // not superseded — must survive

		// Both devices ack the full log.
		const head = (await stub.getStatus()).head_seq;
		await stub.getChanges("dev-a", head, 500);
		await stub.getChanges("dev-b", head, 500);

		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT origin_id, rev FROM ops ORDER BY seq")
				.toArray();
			expect(rows).toEqual([
				{ origin_id: "7", rev: 2 },
				{ origin_id: "8", rev: 1 },
			]);
		});
		// The superseding rev still reaches fresh readers.
		const changes = await stub.getChanges("dev-fresh", 0, 500);
		expect(changes.ops.map((op) => [op.origin_id, op.rev])).toEqual([
			["7", 2],
			["8", 1],
		]);
		expect(r2.acked[0].seq).toBe(changes.ops[0].seq);
	});

	it("deletes nothing while any device has not acked past the old rev", async () => {
		const stub = hub("user-compaction-holdback");
		ok(await stub.pushOps("dev-a", [rowOp("7", 1), rowOp("7", 2)]));
		// dev-b registers with cursor 0 (never acked anything).
		await stub.getChanges("dev-b", 0, 500);
		const head = (await stub.getStatus()).head_seq;
		await stub.getChanges("dev-a", head, 500);

		await runDurableObjectAlarm(stub);

		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT COUNT(*) AS n FROM ops")
				.toArray();
			expect(rows[0].n).toBe(2); // both revs survive
		});
	});

	it("running the alarm twice is idempotent", async () => {
		const stub = hub("user-compaction-idempotent");
		ok(await stub.pushOps("dev-a", [rowOp("7", 1), rowOp("7", 2)]));
		const head = (await stub.getStatus()).head_seq;
		await stub.getChanges("dev-a", head, 500);

		await runDurableObjectAlarm(stub);
		await runDurableObjectAlarm(stub);

		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql
				.exec("SELECT rev FROM ops WHERE origin_id = '7'")
				.toArray();
			expect(rows.map((r) => r.rev)).toEqual([2]);
		});
	});
});

describe("front Worker (SELF)", () => {
	const base = "https://sync-hub.test";
	// The real auth path runs in tests (DEV_ALLOW_ANY_TOKEN forced off in
	// vitest.config.ts); the mocked verify endpoint binds this token to
	// user-http. Dedicated auth-branch coverage lives in test/auth.test.ts.
	const headers = {
		Authorization: "Bearer valid-for:user-http",
		"X-User-Id": "user-http",
		"X-Device-Id": "dev-http",
		"Content-Type": "application/json",
	};

	it("round-trips ops through POST /v1/sync/ops and GET /v1/sync/changes", async () => {
		const push = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ops: [rowOp("http-1")] }),
		});
		expect(push.status).toBe(200);
		const pushBody = (await push.json()) as {
			acked: { origin_id: string; seq: number }[];
			head_seq: number;
		};
		expect(pushBody.acked).toHaveLength(1);
		expect(pushBody.acked[0].origin_id).toBe("http-1");

		const changes = await SELF.fetch(
			`${base}/v1/sync/changes?since=0&limit=500`,
			{ headers },
		);
		expect(changes.status).toBe(200);
		const changesBody = (await changes.json()) as {
			epoch: string;
			ops: { origin_id: string; seq: number }[];
			head_seq: number;
			more: boolean;
		};
		expect(changesBody.ops).toHaveLength(1);
		expect(changesBody.ops[0].origin_id).toBe("http-1");
		expect(changesBody.ops[0].seq).toBe(pushBody.acked[0].seq);
		expect(changesBody.more).toBe(false);

		const status = await SELF.fetch(`${base}/v1/sync/status`, { headers });
		expect(status.status).toBe(200);
		const statusBody = (await status.json()) as { head_seq: number };
		expect(statusBody.head_seq).toBe(pushBody.head_seq);
	});

	it("rejects requests without credentials", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/status`);
		expect(res.status).toBe(401);
	});

	it("maps invalid ops to HTTP 400", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				ops: [{ kind: "mutation", origin_id: "m1", body: "not json" }],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("invalid_ops");
	});

	it("404s unknown paths", async () => {
		const res = await SELF.fetch(`${base}/v1/other`, { headers });
		expect(res.status).toBe(404);
	});

	it("413s a batch with more than 500 ops", async () => {
		const ops = Array.from({ length: 501 }, (_, i) => rowOp(`cap-${i}`));
		const res = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ops }),
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("too many ops");
	});

	it("413s a request body over 8,000,000 bytes", async () => {
		const fat = "x".repeat(8_000_001);
		const res = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				ops: [{ kind: "observation", origin_id: "fat", body: fat }],
			}),
		});
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("body exceeds");
	});

	it("400s a whitespace-only X-Device-Id", async () => {
		const res = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers, "X-Device-Id": "   " },
			body: JSON.stringify({ ops: [rowOp("ws-device")] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("X-Device-Id");
	});

	it("trims X-Device-Id so 'dev-x ' and 'dev-x' are the same device", async () => {
		const op = rowOp("trim-1");
		const first = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers, "X-Device-Id": "dev-http-trim " },
			body: JSON.stringify({ ops: [op] }),
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { acked: { seq: number }[] };

		// Same op from the trimmed spelling must dedupe to the same seq —
		// proof both spellings resolved to one origin_device.
		const second = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers, "X-Device-Id": "dev-http-trim" },
			body: JSON.stringify({ ops: [op] }),
		});
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as { acked: { seq: number }[] };
		expect(secondBody.acked[0].seq).toBe(firstBody.acked[0].seq);
	});
});
