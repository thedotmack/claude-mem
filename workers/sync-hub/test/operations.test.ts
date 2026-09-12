import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	OPERATION_PAGE_MAX_BYTES,
	operationPageBytes,
	type OperationalHealth,
	type OperationPage,
} from "../src/operations-protocol";
import type { PushOutcome, PushResult, SyncHub } from "../src/do/SyncHub";
import { observationOp } from "./content-v2-helpers";

const base = "https://sync-hub.test";
const internalHeaders = {
	Authorization: "Bearer test-projector-secret",
	"Content-Type": "application/json",
};

function hub(name: string) {
	return env.SYNC_HUB.getByName(name);
}

function ok(outcome: PushOutcome): PushResult {
	if ("refused" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return outcome;
}

async function operationPage(
	userId: string,
	epoch: string,
	afterSeq: string,
	limit: number,
): Promise<{ response: Response; raw: string; body: OperationPage }> {
	const response = await SELF.fetch(`${base}/internal/v1/sync/operation-page`, {
		method: "POST",
		headers: internalHeaders,
		body: JSON.stringify({
			protocol_version: 1,
			user_id: userId,
			epoch,
			after_seq: afterSeq,
			limit,
		}),
	});
	const raw = await response.text();
	return { response, raw, body: JSON.parse(raw) as OperationPage };
}

async function operationalHealth(userId: string, windowSeconds = 3_600): Promise<{
	response: Response;
	raw: string;
	body: OperationalHealth;
}> {
	const response = await SELF.fetch(`${base}/internal/v1/sync/operational-health`, {
		method: "POST",
		headers: internalHeaders,
		body: JSON.stringify({ protocol_version: 1, user_id: userId, window_seconds: windowSeconds }),
	});
	const raw = await response.text();
	return { response, raw, body: JSON.parse(raw) as OperationalHealth };
}

describe("internal bounded restore operation pages", () => {
	it("fails closed, enforces exact bodies, and keeps user logs tenant-isolated", async () => {
		const userA = "restore-tenant-a";
		const userB = "restore-tenant-b";
		const stubA = hub(userA);
		const stubB = hub(userB);
		ok(await stubA.pushOps("dev-a", [await observationOp("1", "1", "dev-a", { text: "tenant-a-only" })]));
		ok(await stubB.pushOps("dev-b", [await observationOp("1", "1", "dev-b", { text: "tenant-b-only" })]));
		const epochA = (await stubA.getProjectionState()).epoch;
		const epochB = (await stubB.getProjectionState()).epoch;

		const denied = await SELF.fetch(`${base}/internal/v1/sync/operation-page`, {
			method: "POST",
			headers: { ...internalHeaders, Authorization: "Bearer wrong" },
			body: JSON.stringify({ protocol_version: 1, user_id: userA, epoch: epochA, after_seq: "0", limit: 100 }),
		});
		expect(denied.status).toBe(401);

		const extended = await SELF.fetch(`${base}/internal/v1/sync/operation-page`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({
				protocol_version: 1,
				user_id: userA,
				epoch: epochA,
				after_seq: "0",
				limit: 100,
				include_devices: true,
			}),
		});
		expect(extended.status).toBe(400);

		const pageA = await operationPage(userA, epochA, "0", 100);
		const pageB = await operationPage(userB, epochB, "0", 100);
		expect(pageA.response.status).toBe(200);
		expect(pageB.response.status).toBe(200);
		expect(pageA.response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(pageA.response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(pageA.body.user_id).toBe(userA);
		expect(pageB.body.user_id).toBe(userB);
		expect(pageA.body.ops[0].body).toContain("tenant-a-only");
		expect(pageA.body.ops[0].body).not.toContain("tenant-b-only");
		expect(pageB.body.ops[0].body).toContain("tenant-b-only");
		expect(pageB.body.ops[0].body).not.toContain("tenant-a-only");

		const crossedEpoch = await operationPage(userB, epochA, "0", 100);
		expect(crossedEpoch.response.status).toBe(409);

		const paddedUser = await SELF.fetch(`${base}/internal/v1/sync/operation-page`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({
				protocol_version: 1,
				user_id: ` ${userA}`,
				epoch: epochA,
				after_seq: "0",
				limit: 100,
			}),
		});
		expect(paddedUser.status).toBe(400);
	});

	it("pages more than one page in strict contiguous order with exact cursors", async () => {
		const userId = "restore-multipage";
		const stub = hub(userId);
		const ops = await Promise.all(Array.from({ length: 205 }, (_, index) =>
			observationOp(String(index + 1), "1", "dev-a")
		));
		const pushed = ok(await stub.pushOps("dev-a", ops));
		const epoch = (await stub.getProjectionState()).epoch;

		const first = await operationPage(userId, epoch, "0", 100);
		const second = await operationPage(userId, epoch, first.body.through_seq, 100);
		const third = await operationPage(userId, epoch, second.body.through_seq, 100);
		expect(first.response.status).toBe(200);
		expect(second.response.status).toBe(200);
		expect(third.response.status).toBe(200);
		expect(first.body.ops).toHaveLength(100);
		expect(second.body.ops).toHaveLength(100);
		expect(third.body.ops).toHaveLength(5);
		expect(first.body).toMatchObject({ after_seq: "0", through_seq: "100", head_seq: "205", has_more: true });
		expect(second.body).toMatchObject({ after_seq: "100", through_seq: "200", head_seq: "205", has_more: true });
		expect(third.body).toMatchObject({ after_seq: "200", through_seq: "205", head_seq: pushed.head_seq, has_more: false });
		const sequences = [...first.body.ops, ...second.body.ops, ...third.body.ops].map((op) => op.seq);
		expect(sequences).toEqual(Array.from({ length: 205 }, (_, index) => String(index + 1)));
		for (const item of first.body.ops) expect(Object.keys(item).sort()).toEqual(["body", "operation_sha256", "seq"]);
	});

	it("preserves uint64 decimal coordinates and rejects malformed or overflowing values", async () => {
		const userId = "restore-uint64";
		const stub = hub(userId);
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'head_seq'", "9223372036854775808");
		});
		const pushed = ok(await stub.pushOps("dev-a", [await observationOp("1", "1", "dev-a")]));
		const epoch = (await stub.getProjectionState()).epoch;
		const page = await operationPage(userId, epoch, "9223372036854775808", 1);
		expect(page.response.status).toBe(200);
		expect(page.body.after_seq).toBe("9223372036854775808");
		expect(page.body.through_seq).toBe("9223372036854775809");
		expect(page.body.head_seq).toBe(pushed.head_seq);

		for (const afterSeq of ["01", "-1", "9007199254740992.0", "18446744073709551616"]) {
			const invalid = await SELF.fetch(`${base}/internal/v1/sync/operation-page`, {
				method: "POST",
				headers: internalHeaders,
				body: JSON.stringify({ protocol_version: 1, user_id: userId, epoch, after_seq: afterSeq, limit: 1 }),
			});
			expect(invalid.status, afterSeq).toBe(400);
		}
	});

	it("enforces the complete 4,000,000-byte response cap", async () => {
		const userId = "restore-byte-cap-α";
		const stub = hub(userId);
		const ops = await Promise.all(Array.from({ length: 17 }, (_, index) =>
			observationOp(String(index + 1), "1", "dev-a", { text: "x".repeat(248_000) })
		));
		ok(await stub.pushOps("dev-a", ops));
		const epoch = (await stub.getProjectionState()).epoch;
		const first = await operationPage(userId, epoch, "0", 100);
		expect(first.response.status).toBe(200);
		expect(new TextEncoder().encode(first.raw).length).toBeLessThanOrEqual(OPERATION_PAGE_MAX_BYTES);
		expect(operationPageBytes(first.body)).toBe(new TextEncoder().encode(first.raw).length);
		expect(first.body.ops.length).toBeGreaterThan(0);
		expect(first.body.ops.length).toBeLessThan(ops.length);
		expect(first.body.has_more).toBe(true);

		const second = await operationPage(userId, epoch, first.body.through_seq, 100);
		expect(second.response.status).toBe(200);
		expect(new TextEncoder().encode(second.raw).length).toBeLessThanOrEqual(OPERATION_PAGE_MAX_BYTES);
		expect([...first.body.ops, ...second.body.ops]).toHaveLength(17);
		expect(second.body.has_more).toBe(false);
	});

	it("rejects oversized internal control requests", async () => {
		const oversizedRequest = await SELF.fetch(`${base}/internal/v1/sync/operation-page`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({
				protocol_version: 1,
				user_id: "x".repeat(16_384),
				epoch: "1",
				after_seq: "0",
				limit: 1,
			}),
		});
		expect(oversizedRequest.status).toBe(413);
	});

	it("does not mutate cursors, checkpoint, lease, devices, counters, or alarms", async () => {
		const userId = "restore-read-only";
		const stub = hub(userId);
		ok(await stub.pushOps("dev-a", [await observationOp("1", "1", "dev-a")], "Writer"));
		const epoch = (await stub.getProjectionState()).epoch;
		const snapshot = async () => runInDurableObject(stub, async (_instance: SyncHub, state) => ({
			meta: state.storage.sql.exec<{ k: string; v: string }>("SELECT k, v FROM meta ORDER BY k").toArray(),
			devices: state.storage.sql.exec<Record<string, string | number | null>>("SELECT * FROM devices ORDER BY device_id").toArray(),
			events: state.storage.sql.exec<Record<string, string | number>>("SELECT * FROM operational_event_buckets ORDER BY kind, code, occurred_at_ms").toArray(),
			ops: state.storage.sql.exec<{ seq: string }>("SELECT seq FROM canonical_ops ORDER BY LENGTH(seq), seq").toArray(),
			heads: state.storage.sql.exec<{ entity_id: string; seq: string }>("SELECT entity_id, seq FROM entity_heads ORDER BY entity_id").toArray(),
			alarm: await state.storage.getAlarm(),
		}));
		const before = await snapshot();
		const page = await operationPage(userId, epoch, "0", 100);
		expect(page.response.status).toBe(200);
		expect(await snapshot()).toEqual(before);
	});

	it("fails explicitly at a compacted log boundary instead of silently skipping", async () => {
		const userId = "restore-compaction-boundary";
		const stub = hub(userId);
		ok(await stub.pushOps("dev-a", [await observationOp("1"), await observationOp("2")]));
		const epoch = (await stub.getProjectionState()).epoch;
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			state.storage.sql.exec("DELETE FROM canonical_ops WHERE seq = '1'");
		});

		const unavailable = await operationPage(userId, epoch, "0", 100);
		expect(unavailable.response.status).toBe(409);
		expect(unavailable.raw).toContain("log_gap");
		const atBoundary = await operationPage(userId, epoch, "1", 100);
		expect(atBoundary.response.status).toBe(200);
		expect(atBoundary.body.ops.map((op) => op.seq)).toEqual(["2"]);
	});

	it("never returns a stored row beyond the authoritative head", async () => {
		const userId = "restore-head-boundary";
		const stub = hub(userId);
		ok(await stub.pushOps("dev-a", [await observationOp("1"), await observationOp("2")]));
		const epoch = (await stub.getProjectionState()).epoch;
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			state.storage.sql.exec("UPDATE meta SET v = '1' WHERE k = 'head_seq'");
		});

		const page = await operationPage(userId, epoch, "0", 100);
		expect(page.response.status).toBe(200);
		expect(page.body).toMatchObject({ through_seq: "1", head_seq: "1", has_more: false });
		expect(page.body.ops.map((op) => op.seq)).toEqual(["1"]);
	});
});

describe("internal payload-free operational health", () => {
	it("aggregates fixed codes in a rolling window and prunes expired buckets", async () => {
		const userId = "operational-window";
		const stub = hub(userId);
		const now = 200_000_000;
		await stub.recordOperationalEvent("rejected_operation", "invalid_json", now - 60_001);
		await stub.recordOperationalEvent("rejected_operation", "invalid_json", now - 60_000);
		await stub.recordOperationalEvent("rejected_operation", "stale_revision", now - 1_000);
		await stub.recordOperationalEvent("projection_failure", "upstream_timeout", now);

		const health = await stub.getOperationalHealth(userId, 60, now);
		expect(health.rejected_operations).toEqual({
			total: "2",
			last_at: new Date(now - 1_000).toISOString(),
			by_code: [
				{ code: "invalid_json", count: "1" },
				{ code: "stale_revision", count: "1" },
			],
		});
		expect(health.projection_failures).toEqual({
			total: "1",
			last_at: new Date(now).toISOString(),
			by_code: [{ code: "upstream_timeout", count: "1" }],
		});

		await stub.recordOperationalEvent("projection_failure", "busy", now + 86_400_002);
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql.exec<{ code: string }>(
				"SELECT code FROM operational_event_buckets ORDER BY code",
			).toArray();
			expect(rows).toEqual([{ code: "busy" }]);
		});

		await runInDurableObject(stub, (instance: SyncHub) => {
			expect(() => instance.recordOperationalEvent(
				"rejected_operation",
				"raw-secret" as never,
				now,
			)).toThrow("not allowlisted");
			expect(() => instance.getOperationalHealth(userId, 60, Number.MAX_SAFE_INTEGER))
				.toThrow("ECMAScript Date range");
		});
	});

	it("counts rejected appends without allocating a sequence and exposes no payload or secret fields", async () => {
		const userId = "operational-rejections";
		const headers = {
			Authorization: `Bearer valid-for:${userId}`,
			"X-User-Id": userId,
			"X-Device-Id": "dev-a",
			"Content-Type": "application/json",
		};
		const invalidJson = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: "{not-json",
		});
		expect(invalidJson.status).toBe(400);
		const invalidOp = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({ protocol_version: 2, ops: [{ body: "{}", operation_sha256: "secret-looking-hash" }] }),
		});
		expect(invalidOp.status).toBe(400);

		const state = await hub(userId).getStatus();
		expect(state).toMatchObject({ head_seq: "0", op_count: 0 });
		const health = await operationalHealth(userId);
		expect(health.response.status).toBe(200);
		expect(health.response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(health.response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(health.body.rejected_operations).toMatchObject({
			total: "2",
			by_code: [
				{ code: "invalid_json", count: "1" },
				{ code: "invalid_operation", count: "1" },
			],
		});
		expect(health.body.projection_failures).toEqual({ total: "0", last_at: null, by_code: [] });
		expect(health.raw).not.toContain("secret-looking-hash");
		for (const forbidden of ["body", "payload", "token", "device_id", "devices", "raw", "error"]) {
			expect(health.body).not.toHaveProperty(forbidden);
		}
		expect(Object.keys(health.body).sort()).toEqual([
			"epoch",
			"generated_at",
			"head_seq",
			"projected_seq",
			"projection_failures",
			"projection_lag_ops",
			"protocol_version",
			"rejected_operations",
			"user_id",
			"window_seconds",
		]);
	});

	it("accounts for Worker projection failures while preserving durable append/checkpoint semantics", async () => {
		const userId = "77777777-7777-4777-8777-777777777777";
		const response = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: {
				Authorization: `Bearer valid-for:${userId}`,
				"X-User-Id": userId,
				"X-Device-Id": "dev-a",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ protocol_version: 2, ops: [await observationOp("1", "1", "dev-a")] }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ durable: true, retryable: false, head_seq: "1", projected_seq: "0" });

		const health = await operationalHealth(userId);
		expect(health.response.status).toBe(200);
		expect(health.body).toMatchObject({ head_seq: "1", projected_seq: "0", projection_lag_ops: "1" });
		expect(health.body.projection_failures).toEqual({
			total: "1",
			last_at: expect.stringMatching(/Z$/),
			by_code: [{ code: "upstream_conflict", count: "1" }],
		});
		expect(health.body.rejected_operations.total).toBe("0");
	});

	it("fails closed on auth, exact-body, and window bounds without altering metadata", async () => {
		const userId = "operational-contract";
		const metadataBefore = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId }),
		});
		const before = await metadataBefore.json();

		const denied = await SELF.fetch(`${base}/internal/v1/sync/operational-health`, {
			method: "POST",
			headers: { ...internalHeaders, Authorization: "Bearer wrong" },
			body: JSON.stringify({ protocol_version: 1, user_id: userId, window_seconds: 60 }),
		});
		expect(denied.status).toBe(401);
		for (const windowSeconds of [59, 86_401, 60.5]) {
			const invalid = await SELF.fetch(`${base}/internal/v1/sync/operational-health`, {
				method: "POST",
				headers: internalHeaders,
				body: JSON.stringify({ protocol_version: 1, user_id: userId, window_seconds: windowSeconds }),
			});
			expect(invalid.status, String(windowSeconds)).toBe(400);
		}
		const extended = await SELF.fetch(`${base}/internal/v1/sync/operational-health`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId, window_seconds: 60, include_payloads: true }),
		});
		expect(extended.status).toBe(400);
		const paddedUser = await SELF.fetch(`${base}/internal/v1/sync/operational-health`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: ` ${userId}`, window_seconds: 60 }),
		});
		expect(paddedUser.status).toBe(400);

		const metadataAfter = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId }),
		});
		expect(await metadataAfter.json()).toEqual(before);
	});
});
