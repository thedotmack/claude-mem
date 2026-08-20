import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	incrementCanonicalDecimal,
	parseCanonicalOperation,
	sha256Base64Url,
	stableDocumentId,
	wrapCanonicalBody,
	type CanonicalContentBody,
} from "../src/canonical-content";
import {
	DEVICE_LIMIT_ERROR,
	MAX_DEVICES_PER_USER,
	PROJECTION_LEASE_MS,
	type ChangesOutcome,
	type ChangesResult,
	type PushOutcome,
	type PushResult,
	type StatusOutcome,
	type StatusResult,
	type SyncHub,
} from "../src/do/SyncHub";
import { KILL_SWITCH_KEY } from "../src/kill-switch";
import {
	PROJECTION_FETCH_TIMEOUT_MS,
	PROJECTION_PAGE_MAX_BYTES,
	projectionRequestBytes,
} from "../src/projection-protocol";
import { drainProjection, fetchProjectionWithTimeout } from "../src/index";
import {
	contractFixture,
	fixtureOp,
	observationOp,
	tombstoneOp,
} from "./content-v2-helpers";

function hub(name: string) {
	return env.SYNC_HUB.getByName(name);
}

function projectionEnv(mode: string): Env {
	return {
		...env,
		INTERNAL_PROJECTOR_URL: `https://projection-cases.test/api/internal/sync/project?mode=${mode}`,
		CMEM_INTERNAL_PROJECTOR_SECRET: "test-projector-secret",
	} as Env;
}

function ok(outcome: PushOutcome): PushResult {
	if ("refused" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return outcome;
}

function changes(outcome: ChangesOutcome): ChangesResult {
	if ("refused" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return outcome;
}

function status(outcome: StatusOutcome): StatusResult {
	if ("refused" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return outcome;
}

function refused(outcome: PushOutcome, pattern: RegExp): void {
	expect(outcome).toHaveProperty("refused", true);
	expect((outcome as { error: string }).error).toMatch(pattern);
}

function setBodyPath(body: CanonicalContentBody, path: string, value: string): void {
	const segments = path.split(".");
	let parent = body as unknown as Record<string, unknown>;
	for (const segment of segments.slice(0, -1)) {
		parent = parent[segment] as Record<string, unknown>;
	}
	parent[segments.at(-1)!] = value;
}

function getBodyPath(body: CanonicalContentBody, path: string): unknown {
	let value: unknown = body;
	for (const segment of path.split(".")) {
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

async function uncheckedCanonicalWrapper(body: CanonicalContentBody): Promise<{
	body: string;
	operation_sha256: string;
}> {
	const serialized = canonicalJson(body);
	return {
		body: serialized,
		operation_sha256: await sha256Base64Url(serialized),
	};
}

describe("shared canonical content-v2 contract", () => {
	it("matches every stable-id, JSON, payload-hash, and operation-hash vector", async () => {
		for (const vector of contractFixture.stable_id_vectors) {
			expect(canonicalJson([
				"cmem-doc-id-v1",
				"device",
				vector.kind,
				vector.origin_device_id,
				vector.origin_local_id,
			])).toBe(vector.canonical_input);
			expect(await stableDocumentId(
				vector.kind as "observation" | "summary" | "prompt",
				vector.origin_device_id,
				vector.origin_local_id,
			)).toBe(vector.id);
		}
		for (const vector of contractFixture.canonical_json_vectors) {
			expect(canonicalJson(vector.input)).toBe(vector.canonical);
		}
		for (const vector of contractFixture.payload_hash_vectors) {
			expect(canonicalJson(vector.payload)).toBe(vector.payload_json);
			expect(await sha256Base64Url(vector.payload_json)).toBe(vector.payload_sha256);
		}
		for (const vector of contractFixture.operation_hash_vectors) {
			expect(await sha256Base64Url(vector.body)).toBe(vector.operation_sha256);
			const parsed = await parseCanonicalOperation({
				body: vector.body,
				operation_sha256: vector.operation_sha256,
			});
			expect(canonicalJson(parsed.body)).toBe(vector.body);
		}
	});

	it("rejects unsafe numbers, uint64 overflow, and UTF-8 body overflow", async () => {
		expect(() => canonicalJson({ n: 9_007_199_254_740_992 })).toThrow(/safe/);
		await expect(stableDocumentId("observation", "dev", "18446744073709551616"))
			.rejects.toThrow(/uint64/);
		const valid = await observationOp("1", "1", "dev", { text: "x".repeat(255_000) });
		expect(new TextEncoder().encode(valid.body).length).toBeLessThanOrEqual(256_000);
		await expect(observationOp("2", "1", "dev", { text: "x".repeat(256_000) }))
			.rejects.toThrow(/exceeds 256000/);
		expect(new TextEncoder().encode(contractFixture.byte_boundary_vectors[2].value).length).toBe(4);
	});

	it("increments the full uint64 decimal range without JS-number coercion", () => {
		expect(incrementCanonicalDecimal("9007199254740991")).toBe("9007199254740992");
		expect(incrementCanonicalDecimal("9223372036854775807")).toBe("9223372036854775808");
		expect(incrementCanonicalDecimal("18446744073709551614")).toBe("18446744073709551615");
		expect(() => incrementCanonicalDecimal("18446744073709551615")).toThrow(/uint64/);
	});

	it("enforces every shared mutation string boundary in UTF-8 bytes", async () => {
		for (const vector of contractFixture.mutation_utf8_boundary_vectors) {
			const value = vector.segments.map((segment) => segment.value.repeat(segment.count)).join("");
			expect(new TextEncoder().encode(value).length, vector.name).toBe(vector.utf8_bytes);
			for (const path of vector.paths) {
				const fixture = fixtureOp(vector.operation);
				const body = JSON.parse(fixture.body) as CanonicalContentBody;
				setBodyPath(body, path, value);
				if (vector.accepted) {
					await expect(wrapCanonicalBody(body), `${vector.name}: ${path}`).resolves.toBeDefined();
				} else {
					await expect(wrapCanonicalBody(body), `${vector.name}: ${path}`).rejects.toThrow(/bounded/);
				}
			}
		}
	});

	it("rejects all shared empty/whitespace filterable vectors without trimming accepted bytes", async () => {
		for (const vector of contractFixture.filterable_non_blank_vectors) {
			for (const path of vector.paths) {
				const fixture = fixtureOp(vector.operation);
				const body = JSON.parse(fixture.body) as CanonicalContentBody;
				setBodyPath(body, path, vector.value);
				if (body.payload !== null) {
					body.payload_sha256 = await sha256Base64Url(canonicalJson(body.payload));
				}
				if (vector.accepted) {
					await expect(wrapCanonicalBody(body), `${vector.name}: ${path}`).resolves.toBeDefined();
				} else {
					await expect(wrapCanonicalBody(body), `${vector.name}: ${path}`).rejects.toThrow(
						/non-whitespace|non-empty bounded|non-empty string/,
					);
				}

				const padded = ` \tkept exactly for ${path}\n `;
				const paddedBody = JSON.parse(fixture.body) as CanonicalContentBody;
				setBodyPath(paddedBody, path, padded);
				if (paddedBody.payload !== null) {
					paddedBody.payload_sha256 = await sha256Base64Url(canonicalJson(paddedBody.payload));
				}
				const wrapped = await wrapCanonicalBody(paddedBody);
				const reparsed = JSON.parse(wrapped.body) as CanonicalContentBody;
				expect(getBodyPath(reparsed, path), `${vector.name}: ${path}`).toBe(padded);
			}
		}
	});

	it("refuses every valid-hash blank wrapper before seq allocation and durably preserves padded bodies", async () => {
		let caseIndex = 0;
		for (const vector of contractFixture.filterable_non_blank_vectors) {
			for (const path of vector.paths) {
				caseIndex++;
				const fixture = fixtureOp(vector.operation);
				const invalidBody = JSON.parse(fixture.body) as CanonicalContentBody;
				setBodyPath(invalidBody, path, vector.value);
				if (invalidBody.payload !== null) {
					invalidBody.payload_sha256 = await sha256Base64Url(canonicalJson(invalidBody.payload));
				}
				const invalidWrapper = await uncheckedCanonicalWrapper(invalidBody);
				const stub = hub(`filterable-integration-${caseIndex}`);
				refused(
					await stub.pushOps(invalidBody.origin_device_id, [invalidWrapper]),
					/non-whitespace|non-empty bounded|non-empty string/,
				);
				expect(await stub.getStatus(), `${vector.name}: ${path}`).toMatchObject({
					head_seq: "0",
					op_count: 0,
				});

				const padded = ` \tstored exactly for ${vector.name}:${path}\n `;
				const paddedBody = JSON.parse(fixture.body) as CanonicalContentBody;
				setBodyPath(paddedBody, path, padded);
				if (paddedBody.payload !== null) {
					paddedBody.payload_sha256 = await sha256Base64Url(canonicalJson(paddedBody.payload));
				}
				const paddedWrapper = await wrapCanonicalBody(paddedBody);
				const appended = ok(await stub.pushOps(paddedBody.origin_device_id, [paddedWrapper]));
				expect(appended.acked[0].seq, `${vector.name}: ${path}`).toBe("1");
				expect(appended.acked[0].operation_sha256).toBe(paddedWrapper.operation_sha256);

				const stored = changes(await stub.getChanges("first-reader", "0", 500));
				expect(stored.ops).toHaveLength(1);
				expect(stored.ops[0].seq).toBe("1");
				expect(stored.ops[0].body).toBe(paddedWrapper.body);
				expect(stored.ops[0].operation_sha256).toBe(paddedWrapper.operation_sha256);
				const reparsed = JSON.parse(stored.ops[0].body) as CanonicalContentBody;
				expect(getBodyPath(reparsed, path), `${vector.name}: ${path}`).toBe(padded);
			}
		}
	}, 15_000);
});

describe("canonical reducer and entity-head ledger", () => {
	it("replays the same revision/hash, conflicts on a different hash, and rejects stale revisions", async () => {
		const stub = hub("reducer-retry-conflict");
		const firstOp = await observationOp("1");
		const first = ok(await stub.pushOps("dev-a", [firstOp]));
		const replay = ok(await stub.pushOps("dev-a", [firstOp]));
		expect(replay.acked[0].seq).toBe(first.acked[0].seq);
		expect(first.acked[0].operation_sha256).toBe(firstOp.operation_sha256);
		expect(replay.acked[0].operation_sha256).toBe(firstOp.operation_sha256);
		expect(replay.head_seq).toBe(first.head_seq);

		const conflicting = await observationOp("1", "1", "dev-a", { text: "different" });
		refused(await stub.pushOps("dev-a", [conflicting]), /revision_hash_conflict/);
		const second = ok(await stub.pushOps("dev-a", [await observationOp("1", "2")]));
		refused(await stub.pushOps("dev-a", [firstOp]), /stale_revision/);
		expect(status(await stub.getStatus()).head_seq).toBe(second.head_seq);
	});

	it("supports tombstone-before-create and a higher-revision revive", async () => {
		const stub = hub("reducer-delete-before-create");
		const deletion = ok(await stub.pushOps("dev-a", [await tombstoneOp("9", "2")]));
		refused(await stub.pushOps("dev-a", [await observationOp("9", "1")]), /stale_revision/);
		const revived = ok(await stub.pushOps("dev-a", [await observationOp("9", "3")]));
		expect(BigInt(revived.acked[0].seq)).toBeGreaterThan(BigInt(deletion.acked[0].seq));
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const head = state.storage.sql.exec<{ entity_rev: string; deleted: number }>(
				"SELECT entity_rev, deleted FROM entity_heads",
			).one();
			expect(head).toEqual({ entity_rev: "3", deleted: 0 });
		});
	});

	it("validates the whole batch before allocating a sequence", async () => {
		const stub = hub("validate-before-seq");
		const valid = await observationOp("1");
		refused(await stub.pushOps("dev-a", [valid, { body: "{}", operation_sha256: "x" }]), /ops\[1\]/);
		const result = ok(await stub.pushOps("dev-a", [valid]));
		expect(result.acked[0].seq).toBe("1");
	});

	it("accepts all guarded mutation fixture envelopes without changing their bytes", async () => {
		const stub = hub("mutation-fixtures");
		const names = ["set_prompt_session", "set_title_noop", "remap_project"];
		const result = ok(await stub.pushOps("device-α\u0000west", names.map(fixtureOp)));
		expect(result.acked.map((item) => item.kind)).toEqual(["mutation", "mutation", "mutation"]);
	});

	it("stores and pages seq, entity_rev, cursors, and origin IDs above signed/safe integer limits", async () => {
		const stub = hub("uint64-decimal-storage");
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			state.storage.sql.exec(
				"UPDATE meta SET v = ? WHERE k = 'head_seq'",
				"9223372036854775808",
			);
		});
		const result = ok(await stub.pushOps("dev-a", [
			await observationOp("18446744073709551615", "18446744073709551615"),
		]));
		expect(result.acked[0]).toMatchObject({
			origin_local_id: "18446744073709551615",
			entity_rev: "18446744073709551615",
			seq: "9223372036854775809",
		});
		const page = changes(await stub.getChanges("dev-reader", "9223372036854775808", 500));
		expect(page.ops.map((op) => op.seq)).toEqual(["9223372036854775809"]);
		expect(page.head_seq).toBe("9223372036854775809");
	});
});

describe("projection checkpoint, lease fencing, and launch log retention", () => {
	it("does not advance on a crash before checkpoint and resumes from the authoritative Hub checkpoint", async () => {
		const stub = hub("projection-crash");
		const pushed = ok(await stub.pushOps("dev-a", [await observationOp("1"), await observationOp("2")]));
		const lease1 = await stub.acquireProjectionLease(pushed.head_seq, 1_000);
		expect(lease1.acquired).toBe(true);
		const page1 = await stub.getProjectionPage(lease1.lease_token!, pushed.head_seq, "projection-crash", 100, 4_000_000, 1_001);
		expect(page1.from_seq_exclusive).toBe("0");
		expect(page1.through_seq).toBe("2");
		// Simulate a Worker crash: Pro may have accepted page1, but Hub never CAS-advanced.
		const lease2 = await stub.acquireProjectionLease(pushed.head_seq, PROJECTION_LEASE_MS + 1_001);
		expect(lease2.acquired).toBe(true);
		const page2 = await stub.getProjectionPage(
			lease2.lease_token!,
			pushed.head_seq,
			"projection-crash",
			100,
			4_000_000,
			PROJECTION_LEASE_MS + 1_002,
		);
		expect(page2.from_seq_exclusive).toBe("0");
		await stub.advanceProjectionCheckpoint(
			lease2.lease_token!,
			page2.epoch,
			page2.from_seq_exclusive,
			page2.through_seq,
			PROJECTION_LEASE_MS + 1_003,
		);
		expect((await stub.getProjectionState()).projected_seq).toBe(pushed.head_seq);
	});

	it("keeps cursor-0 history after every launch-era compaction alarm path", async () => {
		const stub = hub("compaction-launch-disabled");
		ok(await stub.pushOps("dev-a", [await observationOp("7", "1")]));
		const second = ok(await stub.pushOps("dev-a", [await observationOp("7", "2")]));
		// Satisfy every watermark condition the retired compactor used: the
		// existing fleet has acknowledged head and Pro has checkpointed head.
		await stub.getChanges("dev-a", second.head_seq, 500);
		const lease = await stub.acquireProjectionLease(second.head_seq);
		const page = await stub.getProjectionPage(lease.lease_token!, second.head_seq, "compaction-launch-disabled");
		await stub.advanceProjectionCheckpoint(lease.lease_token!, page.epoch, "0", page.through_seq);
		await stub.releaseProjectionLease(lease.lease_token!);

		await runDurableObjectAlarm(stub);
		await runDurableObjectAlarm(stub);
		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const rows = state.storage.sql.exec<{ seq: string; entity_rev: string }>(
				"SELECT seq, entity_rev FROM canonical_ops ORDER BY LENGTH(seq), seq",
			).toArray();
			expect(rows).toEqual([
				{ seq: "1", entity_rev: "1" },
				{ seq: "2", entity_rev: "2" },
			]);
		});

		const firstSeen = changes(await stub.getChanges("brand-new-device", "0", 500));
		expect(firstSeen.ops.map((op) => op.seq)).toEqual(["1", "2"]);
		expect(firstSeen.ops.every((op, index) => BigInt(op.seq) === BigInt(index + 1))).toBe(true);
		expect(firstSeen.head_seq).toBe("2");
		expect(firstSeen.more).toBe(false);
	});

	it("enforces 100-op projection pages", async () => {
		const stub = hub("projection-page-bounds");
		const ops = await Promise.all(Array.from({ length: 101 }, (_, index) => observationOp(String(index + 1))));
		const pushed = ok(await stub.pushOps("dev-a", ops));
		const lease = await stub.acquireProjectionLease(pushed.head_seq);
		const page = await stub.getProjectionPage(lease.lease_token!, pushed.head_seq, "projection-page-bounds", 500, 9_000_000);
		expect(page.ops).toHaveLength(100);
		expect(projectionRequestBytes({
			userId: "projection-page-bounds",
			epoch: page.epoch,
			fromSeqExclusive: page.from_seq_exclusive,
			throughSeq: page.through_seq,
			ops: page.ops,
		})).toBeLessThanOrEqual(PROJECTION_PAGE_MAX_BYTES);
	});

	it("accounts for the exact complete projection JSON envelope at the byte boundary", async () => {
		const userId = "projection-byte-boundary-α";
		const stub = hub(userId);
		const pushed = ok(await stub.pushOps("dev-a", [
			await observationOp("1"),
			await observationOp("2"),
			await observationOp("3"),
		]));
		const lease = await stub.acquireProjectionLease(pushed.head_seq);
		const full = await stub.getProjectionPage(lease.lease_token!, pushed.head_seq, userId);
		const exactBytes = projectionRequestBytes({
			userId,
			epoch: full.epoch,
			fromSeqExclusive: full.from_seq_exclusive,
			throughSeq: full.through_seq,
			ops: full.ops,
		});
		const exact = await stub.getProjectionPage(
			lease.lease_token!, pushed.head_seq, userId, 100, exactBytes,
		);
		expect(exact.ops).toHaveLength(3);
		const oneByteShort = await stub.getProjectionPage(
			lease.lease_token!, pushed.head_seq, userId, 100, exactBytes - 1,
		);
		expect(oneByteShort.ops).toHaveLength(2);
	});

	it("never emits a complete projection request above 4,000,000 bytes", async () => {
		const userId = "projection-four-million-boundary";
		const stub = hub(userId);
		const ops = await Promise.all(Array.from(
			{ length: 17 },
			(_, index) => observationOp(String(index + 1), "1", "dev-a", { text: "x".repeat(248_000) }),
		));
		const pushed = ok(await stub.pushOps("dev-a", ops));
		const lease = await stub.acquireProjectionLease(pushed.head_seq);
		const page = await stub.getProjectionPage(lease.lease_token!, pushed.head_seq, userId);
		const pageBytes = projectionRequestBytes({
			userId,
			epoch: page.epoch,
			fromSeqExclusive: page.from_seq_exclusive,
			throughSeq: page.through_seq,
			ops: page.ops,
		});
		expect(pageBytes).toBeLessThanOrEqual(PROJECTION_PAGE_MAX_BYTES);
		expect(page.ops.length).toBeLessThan(ops.length);
		const next = ok(await stub.pushOps("dev-a", []));
		expect(next.head_seq).toBe(pushed.head_seq);
		const allChanges = changes(await stub.getChanges("boundary-reader", "0", 500));
		const nextOp = allChanges.ops[page.ops.length];
		expect(projectionRequestBytes({
			userId,
			epoch: page.epoch,
			fromSeqExclusive: page.from_seq_exclusive,
			throughSeq: nextOp.seq,
			ops: [...page.ops, nextOp],
		})).toBeGreaterThan(PROJECTION_PAGE_MAX_BYTES);
	});

	it("heartbeats a lease, refuses concurrent acquire, and fences stale replay", async () => {
		const userId = "projection-fencing";
		const stub = hub(userId);
		const pushed = ok(await stub.pushOps("dev-a", [await observationOp("1")]));
		const first = await stub.acquireProjectionLease(pushed.head_seq, 1_000);
		expect(first.acquired).toBe(true);
		expect((await stub.acquireProjectionLease(pushed.head_seq, 2_000)).acquired).toBe(false);
		await stub.heartbeatProjectionLease(first.lease_token!, 50_000);
		expect((await stub.acquireProjectionLease(pushed.head_seq, 91_001)).acquired).toBe(false);
		const successor = await stub.acquireProjectionLease(pushed.head_seq, 140_001);
		expect(successor.acquired).toBe(true);
		await runInDurableObject(stub, (instance: SyncHub) => {
			expect(() => instance.advanceProjectionCheckpoint(
				first.lease_token!, first.epoch, "0", pushed.head_seq, 140_002,
			)).toThrow(/projection lease is not held/);
		});
		const page = await stub.getProjectionPage(
			successor.lease_token!, pushed.head_seq, userId, 100, 4_000_000, 140_002,
		);
		await stub.advanceProjectionCheckpoint(
			successor.lease_token!, page.epoch, page.from_seq_exclusive, page.through_seq, 140_003,
		);
		expect((await stub.getProjectionState()).projected_seq).toBe(pushed.head_seq);
	});

	it("aborts a stalled projection response body before its lease can expire", async () => {
		const stalledFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		};
		await expect(fetchProjectionWithTimeout(
			"https://projector.test/api/internal/sync/project",
			"{}",
			"test-secret",
			5,
			stalledFetch,
		)).rejects.toThrow("projection_upstream_timeout");
		await expect(fetchProjectionWithTimeout(
			"https://projector.test/api/internal/sync/project",
			"{}",
			"test-secret",
			PROJECTION_LEASE_MS,
			stalledFetch,
		)).rejects.toThrow(/strictly shorter/);
	});

	it.each([
		["network", "projection_upstream_unreachable"],
		["retryable", "projection_upstream_503"],
		["truncated", "projection_response_not_json"],
		["mismatch", "projection_response_mismatch"],
	])("retains the full lease after ambiguous/retryable projection mode %s", async (mode, expectedError) => {
		const userId = `projection-retain-${mode}`;
		const stub = hub(userId);
		const pushed = ok(await stub.pushOps("dev-a", [await observationOp("1")]));
		const startedAt = 10_000;
		const result = await drainProjection(projectionEnv(mode), userId, pushed.head_seq, {
			now: () => startedAt,
			fetchTimeoutMs: 100,
			...(mode === "network" ? {
				fetchImpl: async () => { throw new Error("simulated network disconnect"); },
			} : {}),
		});
		expect(result).toMatchObject({ ok: false, error: expectedError, retryable: true });
		expect((await stub.getProjectionState()).projected_seq).toBe("0");
		expect((await stub.acquireProjectionLease(
			pushed.head_seq,
			startedAt + PROJECTION_LEASE_MS - 1,
		)).acquired).toBe(false);
		const successor = await stub.acquireProjectionLease(
			pushed.head_seq,
			startedAt + PROJECTION_LEASE_MS,
		);
		expect(successor.acquired).toBe(true);
		await stub.releaseProjectionLease(successor.lease_token!);
	});

	it("keeps an AbortSignal-ignoring delayed HTTP predecessor fenced through 90s, then safely replays", async () => {
		const userId = "projection-delayed-after-abort";
		const stub = hub(userId);
		const pushed = ok(await stub.pushOps("dev-a", [await observationOp("1")]));
		const startedAt = 1_000;

		// The real Miniflare fetch/outbound-service path is wall-clock scaled to
		// 10ms, while the lease assertions retain the production 45s/90s ratio.
		const timedOut = await drainProjection(projectionEnv("delayed"), userId, pushed.head_seq, {
			now: () => startedAt,
			fetchTimeoutMs: 10,
		});
		expect(timedOut).toMatchObject({
			ok: false,
			error: "projection_upstream_timeout",
			retryable: true,
		});
		expect(PROJECTION_FETCH_TIMEOUT_MS).toBe(45_000);
		expect((await stub.acquireProjectionLease(
			pushed.head_seq,
			startedAt + PROJECTION_FETCH_TIMEOUT_MS,
		)).acquired).toBe(false);

		// The delayed Pro-style handler ignores the aborted Request signal and
		// finishes later. Its valid late response must never checkpoint the Hub.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const completion = await fetch(
			`https://projection-cases.test/test/completion?user_id=${encodeURIComponent(userId)}`,
		);
		expect(await completion.json()).toEqual({ completions: 1 });
		expect((await stub.getProjectionState()).projected_seq).toBe("0");
		expect((await stub.acquireProjectionLease(
			pushed.head_seq,
			startedAt + PROJECTION_LEASE_MS - 1,
		)).acquired).toBe(false);

		// At expiry the successor safely replays from the unchanged checkpoint.
		const replay = await drainProjection(projectionEnv("success"), userId, pushed.head_seq, {
			now: () => startedAt + PROJECTION_LEASE_MS,
			fetchTimeoutMs: 100,
		});
		expect(replay).toEqual({ ok: true, projectedSeq: pushed.head_seq });
		expect((await stub.getProjectionState()).projected_seq).toBe(pushed.head_seq);
	});

	it("releases early only for confirmed checkpoint success or deterministic rejection", async () => {
		for (const mode of ["success", "nonretryable"]) {
			const userId = `projection-release-${mode}`;
			const stub = hub(userId);
			const pushed = ok(await stub.pushOps("dev-a", [await observationOp("1")]));
			const startedAt = 20_000;
			const result = await drainProjection(projectionEnv(mode), userId, pushed.head_seq, {
				now: () => startedAt,
				fetchTimeoutMs: 100,
			});
			if (mode === "success") expect(result).toEqual({ ok: true, projectedSeq: pushed.head_seq });
			else expect(result).toMatchObject({ ok: false, httpStatus: 409, retryable: false });
			const immediate = await stub.acquireProjectionLease(pushed.head_seq, startedAt + 1);
			expect(immediate.acquired).toBe(true);
			await stub.releaseProjectionLease(immediate.lease_token!);
		}
	});

	it("releases a redundant lease when a predecessor checkpoints during acquire", async () => {
		let stateReads = 0;
		let releasedToken: string | null = null;
		const stub = {
			getProjectionState: async () => ({
				protocol_version: 1 as const,
				epoch: "race-epoch",
				head_seq: "1",
				projected_seq: stateReads++ === 0 ? "0" : "1",
			}),
			acquireProjectionLease: async () => ({
				acquired: true,
				lease_token: "redundant-token",
				epoch: "race-epoch",
				head_seq: "1",
				projected_seq: "1",
				target_seq: "1",
			}),
			releaseProjectionLease: async (token: string) => { releasedToken = token; },
		};
		const raceEnv = {
			SYNC_HUB: { getByName: () => stub },
			INTERNAL_PROJECTOR_URL: "https://projection-cases.test/api/internal/sync/project?mode=success",
			CMEM_INTERNAL_PROJECTOR_SECRET: "test-projector-secret",
		} as unknown as Env;

		await expect(drainProjection(raceEnv, "projection-acquire-race", "1")).resolves.toEqual({
			ok: true,
			projectedSeq: "1",
		});
		expect(releasedToken).toBe("redundant-token");
	});

	it("retains the lease when a matching 2xx is followed by an ambiguous checkpoint reply", async () => {
		const startedAt = 30_000;
		const userId = "checkpoint-ambiguity";
		const realStub = hub(userId);
		const pushed = ok(await realStub.pushOps("dev-a", [await observationOp("1")]));
		let releaseCalls = 0;
		const proxyStub = {
			getProjectionState: () => realStub.getProjectionState(),
			acquireProjectionLease: (targetSeq: string, now?: number) => (
				now === undefined
					? realStub.acquireProjectionLease(targetSeq)
					: realStub.acquireProjectionLease(targetSeq, now)
			),
			getProjectionPage: (
				leaseToken: string,
				targetSeq: string,
				projectionUserId: string,
				maxOps: number,
				maxBytes: number,
				now?: number,
			) => (
				now === undefined
					? realStub.getProjectionPage(leaseToken, targetSeq, projectionUserId, maxOps, maxBytes)
					: realStub.getProjectionPage(leaseToken, targetSeq, projectionUserId, maxOps, maxBytes, now)
			),
			heartbeatProjectionLease: (leaseToken: string, now?: number) => (
				now === undefined
					? realStub.heartbeatProjectionLease(leaseToken)
					: realStub.heartbeatProjectionLease(leaseToken, now)
			),
			advanceProjectionCheckpoint: async (
				leaseToken: string,
				epoch: string,
				fromSeqExclusive: string,
				throughSeq: string,
				now?: number,
			) => {
				if (now === undefined) {
					await realStub.advanceProjectionCheckpoint(leaseToken, epoch, fromSeqExclusive, throughSeq);
				} else {
					await realStub.advanceProjectionCheckpoint(leaseToken, epoch, fromSeqExclusive, throughSeq, now);
				}
				// Simulate an RPC reply disappearing after the real fenced CAS commits.
				throw new Error("checkpoint reply lost after commit");
			},
			releaseProjectionLease: async (leaseToken: string) => {
				releaseCalls++;
				await realStub.releaseProjectionLease(leaseToken);
			},
		};
		const ambiguousEnv = {
			SYNC_HUB: { getByName: () => proxyStub },
			INTERNAL_PROJECTOR_URL: "https://projection-cases.test/api/internal/sync/project?mode=success",
			CMEM_INTERNAL_PROJECTOR_SECRET: "test-projector-secret",
		} as unknown as Env;
		const result = await drainProjection(ambiguousEnv, userId, pushed.head_seq, {
			now: () => startedAt,
			fetchTimeoutMs: 100,
			fetchImpl: async (_input, init) => {
				const request = JSON.parse(String(init?.body)) as { epoch: string; through_seq: string };
				return Response.json({
					protocol_version: 1,
					epoch: request.epoch,
					projected_through_seq: request.through_seq,
				});
			},
		});

		expect(result).toMatchObject({
			ok: false,
			error: "checkpoint reply lost after commit",
			projectedSeq: pushed.head_seq,
			retryable: true,
		});
		expect(releaseCalls).toBe(0);
		expect((await realStub.getProjectionState()).projected_seq).toBe(pushed.head_seq);
		expect((await realStub.acquireProjectionLease(
			pushed.head_seq,
			startedAt + PROJECTION_LEASE_MS - 1,
		)).acquired).toBe(false);
		expect((await realStub.acquireProjectionLease(
			pushed.head_seq,
			startedAt + PROJECTION_LEASE_MS,
		)).acquired).toBe(true);
		expect(releaseCalls).toBe(0);
	});
});

describe("large cursor pagination", () => {
	it("reads 10,001 canonical operations without overlap or gaps", async () => {
		const stub = hub("pagination-10001");
		for (let start = 1; start <= 10_001; start += 500) {
			const count = Math.min(500, 10_002 - start);
			const batch = await Promise.all(
				Array.from({ length: count }, (_, index) => observationOp(String(start + index))),
			);
			ok(await stub.pushOps("dev-a", batch));
		}
		let cursor = "0";
		let count = 0;
		for (;;) {
			const page = changes(await stub.getChanges("dev-reader", cursor, 500));
			for (const op of page.ops) {
				expect(BigInt(op.seq)).toBe(BigInt(cursor) + 1n);
				cursor = op.seq;
				count++;
			}
			if (!page.more) {
				expect(cursor).toBe(page.head_seq);
				break;
			}
		}
		expect(count).toBe(10_001);
	});
});

describe("front Worker durability and repair", () => {
	const base = "https://sync-hub.test";
	const userId = "55555555-5555-4555-8555-555555555555";
	const headers = {
		Authorization: `Bearer valid-for:${userId}`,
		"X-User-Id": userId,
		"X-Device-Id": "dev-http",
		"Content-Type": "application/json",
	};

	it("keeps a retryable provider failure fenced, then duplicate replay projects after lease expiry", async () => {
		const op = await observationOp("1", "1", "dev-http");
		const requestBody = JSON.stringify({ protocol_version: 2, ops: [op] });
		const first = await SELF.fetch(`${base}/v1/sync/ops`, { method: "POST", headers, body: requestBody });
		expect(first.status).toBe(503);
		const failure = await first.json() as { durable: boolean; head_seq: string; projected_seq: string };
		expect(failure).toMatchObject({ durable: true, head_seq: "1", projected_seq: "0" });

		const busy = await SELF.fetch(`${base}/v1/sync/ops`, { method: "POST", headers, body: requestBody });
		expect(busy.status).toBe(503);
		expect(await busy.json()).toMatchObject({ error: "projection_busy", durable: true, retryable: true });

		const stub = hub(userId);
		const expired = await stub.acquireProjectionLease(
			failure.head_seq,
			Date.now() + PROJECTION_LEASE_MS + 1_000,
		);
		expect(expired.acquired).toBe(true);
		await stub.releaseProjectionLease(expired.lease_token!);
		const retry = await SELF.fetch(`${base}/v1/sync/ops`, { method: "POST", headers, body: requestBody });
		expect(retry.status).toBe(200);
		const success = await retry.json() as {
			acked: Array<{ operation_sha256: string; seq: string }>;
			head_seq: string;
			projected_seq: string;
		};
		expect(success.acked[0].seq).toBe(failure.head_seq);
		expect(success.acked[0].operation_sha256).toBe(op.operation_sha256);
		expect(success.projected_seq).toBe(success.head_seq);
	});

	it("drains the scheduled repair endpoint to the authoritative head", async () => {
		const repairUser = "66666666-6666-4666-8666-666666666666";
		const stub = hub(repairUser);
		ok(await stub.pushOps("dev-a", [await observationOp("1")]));
		const response = await SELF.fetch(`${base}/internal/v1/projection/drain`, {
			method: "POST",
			headers: { Authorization: "Bearer test-projector-secret", "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 1, user_id: repairUser }),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as { head_seq: string; projected_through_seq: string };
		expect(body.projected_through_seq).toBe(body.head_seq);
	});

	it("surfaces deterministic Pro document rejection as nonretryable 409", async () => {
		const rejectedUser = "77777777-7777-4777-8777-777777777777";
		const response = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: {
				...headers,
				Authorization: `Bearer valid-for:${rejectedUser}`,
				"X-User-Id": rejectedUser,
			},
			body: JSON.stringify({
				protocol_version: 2,
				ops: [await observationOp("1", "1", "dev-http")],
			}),
		});
		expect(response.status).toBe(409);
		const body = await response.json() as {
			durable: boolean;
			retryable: boolean;
			head_seq: string;
			projected_seq: string;
		};
		expect(body).toMatchObject({ durable: true, retryable: false, head_seq: "1", projected_seq: "0" });
	});

	it("requires protocol_version 2 and exact canonical wrappers", async () => {
		const noVersion = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({ ops: [await observationOp("2", "1", "dev-http")] }),
		});
		expect(noVersion.status).toBe(400);
		const extraWrapperField = { ...(await observationOp("3", "1", "dev-http")), extra: true };
		const invalid = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers,
			body: JSON.stringify({ protocol_version: 2, ops: [extraWrapperField] }),
		});
		expect(invalid.status).toBe(400);
	});
});

describe("internal payload-free Hub metadata", () => {
	const base = "https://sync-hub.test";
	const internalHeaders = {
		Authorization: "Bearer test-projector-secret",
		"Content-Type": "application/json",
	};

	it("reports device names, last seen, decimal cursors, projection lag, and health", async () => {
		const userId = "88888888-8888-4888-8888-888888888888";
		const stub = hub(userId);
		changes(await stub.getChanges("dev-dashboard", "0", 500));
		const clientStatus = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: {
				Authorization: `Bearer valid-for:${userId}`,
				"X-User-Id": userId,
				"X-Device-Id": "dev-dashboard",
				"X-Device-Name": "  Alex's Laptop  ",
			},
		});
		expect(clientStatus.status).toBe(200);

		ok(await stub.pushOps("dev-writer", [
			await observationOp("1", "1", "dev-writer"),
			await observationOp("2", "1", "dev-writer"),
		], "Writer"));
		await stub.getChanges("dev-reader", "1", 500, "Reader");

		const response = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId }),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as {
			protocol_version: number;
			user_id: string;
			epoch: string;
			head_seq: string;
			projected_seq: string;
			projection_lag_ops: string;
			sync_health: string;
			devices: Array<Record<string, unknown>>;
		};
		expect(body).toMatchObject({
			protocol_version: 1,
			user_id: userId,
			head_seq: "2",
			projected_seq: "0",
			projection_lag_ops: "2",
			sync_health: "projector_lagging",
		});
		expect(body.epoch).toMatch(/^(?:0|[1-9][0-9]*)$/);
		expect(body).not.toHaveProperty("op_count");
		expect(body.devices).toHaveLength(3);
		const byId = new Map(body.devices.map((device) => [device.device_id, device]));
		expect(byId.get("dev-dashboard")).toMatchObject({
			name: "Alex's Laptop",
			last_ack_seq: "0",
			cursor_lag_ops: "2",
			connection_state: "disconnected",
		});
		expect(byId.get("dev-reader")).toMatchObject({
			name: "Reader",
			last_ack_seq: "1",
			cursor_lag_ops: "1",
		});
		for (const device of body.devices) {
			expect(device.last_seen_epoch_ms).toMatch(/^[1-9][0-9]*$/);
			expect(device.last_seen_at).toMatch(/Z$/);
		}
	});

	it("renames only registered devices and preserves dashboard names over client headers", async () => {
		const userId = "99999999-9999-4999-8999-999999999999";
		const stub = hub(userId);
		changes(await stub.getChanges("dev-a", "0", 500, "Initial hostname"));

		const rename = await SELF.fetch(`${base}/internal/v1/sync/device-name`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId, device_id: "dev-a", name: "Desk Mac" }),
		});
		expect(rename.status).toBe(200);
		expect(await rename.json()).toEqual({
			protocol_version: 1,
			user_id: userId,
			device_id: "dev-a",
			name: "Desk Mac",
		});

		await stub.getStatus("dev-a", "Changed hostname");
		const metadata = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId }),
		});
		const body = await metadata.json() as { sync_health: string; projection_lag_ops: string; devices: Array<{ name: string }> };
		expect(body.sync_health).toBe("healthy");
		expect(body.projection_lag_ops).toBe("0");
		expect(body.devices[0].name).toBe("Desk Mac");

		const missing = await SELF.fetch(`${base}/internal/v1/sync/device-name`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId, device_id: "missing", name: "Nope" }),
		});
		expect(missing.status).toBe(404);
	});

	it("fails closed on internal auth and rejects contract extensions", async () => {
		const denied = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 1, user_id: "user" }),
		});
		expect(denied.status).toBe(401);

		const extended = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: "user", include_content_counts: true }),
		});
		expect(extended.status).toBe(400);
	});
});

describe("internal per-user hub reset", () => {
	const base = "https://sync-hub.test";
	const internalHeaders = {
		Authorization: "Bearer test-projector-secret",
		"Content-Type": "application/json",
	};

	function reset(body: unknown, headers: Record<string, string> = internalHeaders): Promise<Response> {
		return SELF.fetch(`${base}/internal/v1/sync/reset`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	}

	it("fails closed without the internal secret and refuses non-POST", async () => {
		const absent = await reset({ protocol_version: 1, user_id: "user" }, {
			"Content-Type": "application/json",
		});
		expect(absent.status).toBe(401);
		const wrong = await reset({ protocol_version: 1, user_id: "user" }, {
			Authorization: "Bearer wrong",
			"Content-Type": "application/json",
		});
		expect(wrong.status).toBe(401);
		// A valid SUBSCRIBER token is not the internal credential either.
		const subscriber = await reset({ protocol_version: 1, user_id: "user" }, {
			Authorization: "Bearer valid-for:user",
			"Content-Type": "application/json",
		});
		expect(subscriber.status).toBe(401);
		const get = await SELF.fetch(`${base}/internal/v1/sync/reset`);
		expect(get.status).toBe(405);
	});

	it("rejects every malformed body with 400", async () => {
		for (const body of [
			{ user_id: "user" },
			{ protocol_version: 2, user_id: "user" },
			{ protocol_version: 1 },
			{ protocol_version: 1, user_id: "" },
			{ protocol_version: 1, user_id: "   " },
			{ protocol_version: 1, user_id: 7 },
			{ protocol_version: 1, user_id: "user", force: true },
			["not", "an", "object"],
		]) {
			expect((await reset(body)).status).toBe(400);
		}
		const notJson = await SELF.fetch(`${base}/internal/v1/sync/reset`, {
			method: "POST",
			headers: internalHeaders,
			body: "{",
		});
		expect(notJson.status).toBe(400);
	});

	it("wipes pushed state to a pristine hub and accepts a fresh seq-1 push under the new epoch", async () => {
		const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const clientHeaders = {
			Authorization: `Bearer valid-for:${userId}`,
			"X-User-Id": userId,
			"X-Device-Id": "dev-a",
			"Content-Type": "application/json",
		};
		const first = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: clientHeaders,
			body: JSON.stringify({
				protocol_version: 2,
				ops: [await observationOp("1", "1", "dev-a"), await observationOp("2", "1", "dev-a")],
			}),
		});
		expect(first.status).toBe(200);
		const pull = await SELF.fetch(`${base}/v1/sync/changes?since=0`, {
			headers: { ...clientHeaders, "X-Device-Id": "dev-b" },
		});
		expect(pull.status).toBe(200);
		const stub = hub(userId);
		const populated = status(await stub.getStatus());
		expect(populated).toMatchObject({ head_seq: "2", projected_seq: "2", op_count: 2, device_count: 2 });

		const response = await reset({ protocol_version: 1, user_id: userId });
		expect(response.status).toBe(200);
		const body = await response.json() as { protocol_version: number; epoch: string; head_seq: string };
		expect(body).toMatchObject({ protocol_version: 1, head_seq: "0" });
		expect(body.epoch).toMatch(/^[1-9][0-9]*$/);
		expect(body.epoch).not.toBe(populated.epoch);

		const pristine = status(await stub.getStatus());
		expect(pristine).toMatchObject({
			epoch: body.epoch,
			head_seq: "0",
			projected_seq: "0",
			op_count: 0,
			device_count: 0,
		});
		// The daily no-op alarm is rescheduled along with the pristine state.
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
		});

		// The same device replays its op from scratch: fresh entity ledger,
		// seq restarts at 1, and the page carries the NEW epoch end to end.
		const repush = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: clientHeaders,
			body: JSON.stringify({ protocol_version: 2, ops: [await observationOp("1", "1", "dev-a")] }),
		});
		expect(repush.status).toBe(200);
		const repushed = await repush.json() as {
			acked: Array<{ seq: string }>;
			head_seq: string;
			projected_seq: string;
		};
		expect(repushed.acked[0].seq).toBe("1");
		expect(repushed).toMatchObject({ head_seq: "1", projected_seq: "1" });
		const page = changes(await stub.getChanges("dev-b", "0", 500));
		expect(page.epoch).toBe(body.epoch);
		expect(page.ops).toHaveLength(1);
		expect(page.ops[0].seq).toBe("1");
	});

	it("creates a pristine hub when resetting a never-seen user", async () => {
		const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const response = await reset({ protocol_version: 1, user_id: userId });
		expect(response.status).toBe(200);
		const body = await response.json() as { epoch: string; head_seq: string };
		expect(body.head_seq).toBe("0");
		expect(body.epoch).toMatch(/^[1-9][0-9]*$/);
		expect(status(await hub(userId).getStatus())).toMatchObject({
			epoch: body.epoch,
			head_seq: "0",
			projected_seq: "0",
			op_count: 0,
			device_count: 0,
		});
	});

	it("trims user_id to the canonical hub name", async () => {
		const userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const stub = hub(userId);
		ok(await stub.pushOps("dev-a", [await observationOp("1")]));
		const response = await reset({ protocol_version: 1, user_id: `  ${userId}  ` });
		expect(response.status).toBe(200);
		expect(status(await stub.getStatus())).toMatchObject({ head_seq: "0", op_count: 0 });
	});

	it("leaves the kill switch untouched — it is Worker-owned KV, not hub state", async () => {
		const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		await env.AUTH_CACHE.put(KILL_SWITCH_KEY, JSON.stringify({ source: "manual", reason: "test" }));
		try {
			const response = await reset({ protocol_version: 1, user_id: userId });
			expect(response.status).toBe(200);
			expect(await env.AUTH_CACHE.get(KILL_SWITCH_KEY)).not.toBeNull();
		} finally {
			await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
		}
	});
});

describe("per-user device admission bound", () => {
	const base = "https://sync-hub.test";
	const internalHeaders = {
		Authorization: "Bearer test-projector-secret",
		"Content-Type": "application/json",
	};

	function clientHeaders(userId: string, deviceId?: string, deviceName?: string): Record<string, string> {
		return {
			Authorization: `Bearer valid-for:${userId}`,
			"X-User-Id": userId,
			...(deviceId === undefined ? {} : { "X-Device-Id": deviceId }),
			...(deviceName === undefined ? {} : { "X-Device-Name": deviceName }),
		};
	}

	async function metadata(userId: string): Promise<{
		devices: Array<{ device_id: string; name: string | null }>;
		head_seq: string;
	}> {
		const response = await SELF.fetch(`${base}/internal/v1/sync/metadata`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({ protocol_version: 1, user_id: userId }),
		});
		expect(response.status).toBe(200);
		return response.json();
	}

	it("direct status refreshes known devices but never admits an unknown probe", async () => {
		const userId = "device-status-direct-read-only";
		const stub = hub(userId);

		expect(status(await stub.getStatus("probe-only", "Must Not Persist")).device_count).toBe(0);
		expect((await metadata(userId)).devices).toEqual([]);

		changes(await stub.getChanges("known-device", "0", 500));
		expect(status(await stub.getStatus("known-device", "Known Name")).device_count).toBe(1);
		expect(await metadata(userId)).toMatchObject({
			devices: [{ device_id: "known-device", name: "Known Name" }],
		});

		expect(status(await stub.getStatus("another-probe", "Still Not Persisted")).device_count).toBe(1);
		expect((await metadata(userId)).devices.map((device) => device.device_id)).toEqual(["known-device"]);
	});

	it("concurrent status probes create zero devices and cannot exhaust admission", async () => {
		const userId = "device-cap-concurrent";
		const probes = await Promise.all(Array.from({ length: 80 }, (_, index) => {
			const device = `device-${String(index).padStart(2, "0")}`;
			return SELF.fetch(`${base}/v1/sync/status`, {
				headers: clientHeaders(userId, device, `Test ${index}`),
			});
		}));
		expect(probes.every((response) => response.status === 200)).toBe(true);
		expect((await metadata(userId)).devices).toEqual([]);

		const admissions = await Promise.all(Array.from({ length: 80 }, (_, index) => {
			const device = `admitted-${String(index).padStart(2, "0")}`;
			return SELF.fetch(`${base}/v1/sync/changes?since=0`, {
				headers: clientHeaders(userId, device, `Admitted ${index}`),
			});
		}));
		const accepted = admissions.filter((response) => response.status === 200);
		const rejected = admissions.filter((response) => response.status === 409);
		expect(accepted).toHaveLength(MAX_DEVICES_PER_USER);
		expect(rejected).toHaveLength(80 - MAX_DEVICES_PER_USER);
		for (const response of rejected) expect(await response.json()).toEqual({ error: DEVICE_LIMIT_ERROR });

		const state = await metadata(userId);
		expect(state.devices).toHaveLength(MAX_DEVICES_PER_USER);
		expect(new Set(state.devices.map((device) => device.device_id)).size).toBe(MAX_DEVICES_PER_USER);
		expect(state.devices.every((device) => device.name?.startsWith("Admitted "))).toBe(true);

		const afterCapProbes = await Promise.all(Array.from({ length: 80 }, (_, index) =>
			SELF.fetch(`${base}/v1/sync/status`, {
				headers: clientHeaders(userId, `post-cap-probe-${index}`),
			})
		));
		expect(afterCapProbes.every((response) => response.status === 200)).toBe(true);
		expect((await metadata(userId)).devices).toHaveLength(MAX_DEVICES_PER_USER);
	});

	it("keeps existing devices writable/readable while new admitting paths are rejected at the cap", async () => {
		const userId = "device-cap-http-paths";
		for (let index = 0; index < MAX_DEVICES_PER_USER; index++) {
			const response = await SELF.fetch(`${base}/v1/sync/changes?since=0`, {
				headers: clientHeaders(userId, `device-${index}`, `Named ${index}`),
			});
			expect(response.status).toBe(200);
		}

		const existingStatus = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: clientHeaders(userId, "device-0", "Changed by client"),
		});
		expect(existingStatus.status).toBe(200);

		const readOnlyNewStatus = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: clientHeaders(userId, "device-new"),
		});
		expect(readOnlyNewStatus.status).toBe(200);

		const rejectedPull = await SELF.fetch(`${base}/v1/sync/changes?since=0`, {
			headers: clientHeaders(userId, "device-pull-new"),
		});
		expect(rejectedPull.status).toBe(409);
		expect(await rejectedPull.json()).toEqual({ error: DEVICE_LIMIT_ERROR });

		const rejectedPush = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...clientHeaders(userId, "device-push-new"), "Content-Type": "application/json" },
			body: JSON.stringify({
				protocol_version: 2,
				ops: [await observationOp("1", "1", "device-push-new")],
			}),
		});
		expect(rejectedPush.status).toBe(409);
		expect(await rejectedPush.json()).toEqual({ error: DEVICE_LIMIT_ERROR });

		const acceptedPush = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...clientHeaders(userId, "device-0"), "Content-Type": "application/json" },
			body: JSON.stringify({
				protocol_version: 2,
				ops: [await observationOp("1", "1", "device-0")],
			}),
		});
		expect(acceptedPush.status).toBe(200);
		const acceptedPull = await SELF.fetch(`${base}/v1/sync/changes?since=0`, {
			headers: clientHeaders(userId, "device-1"),
		});
		expect(acceptedPull.status).toBe(200);
		expect((await acceptedPull.json() as { ops: unknown[] }).ops).toHaveLength(1);

		const readOnlyStatus = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: clientHeaders(userId),
		});
		expect(readOnlyStatus.status).toBe(200);
		const unknownRename = await SELF.fetch(`${base}/internal/v1/sync/device-name`, {
			method: "POST",
			headers: internalHeaders,
			body: JSON.stringify({
				protocol_version: 1,
				user_id: userId,
				device_id: "unknown-rename",
				name: "Must Not Exist",
			}),
		});
		expect(unknownRename.status).toBe(404);

		const state = await metadata(userId);
		expect(state.head_seq).toBe("1");
		expect(state.devices).toHaveLength(MAX_DEVICES_PER_USER);
		expect(state.devices.find((device) => device.device_id === "device-0")?.name).toBe("Named 0");
		expect(state.devices.some((device) => device.device_id === "unknown-rename")).toBe(false);
	});
});
