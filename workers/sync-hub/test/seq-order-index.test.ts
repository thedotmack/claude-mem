/**
 * Coverage for the canonical_ops seq-ordering expression index.
 *
 * SEQ_ORDER is spliced into both the CREATE INDEX and every query, so the two
 * cannot drift apart. What is NOT self-evident is that SQLite's planner picks
 * up an expression index for this shape at all -- and if it ever stops doing
 * so, every range scan silently becomes a full table scan while every other
 * test still passes. These assertions read the query plan, not just the rows,
 * and they import SEQ_ORDER rather than restating it so they test the
 * expression the object is actually built with.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SEQ_ORDER, seqKey, type SyncHub } from "../src/do/SyncHub";
import { observationOp } from "./content-v2-helpers";

function hub(name: string) {
	return env.SYNC_HUB.getByName(name);
}

/** Push `count` distinct ops in one batch -- far faster than one push each. */
async function seedOps(stub: ReturnType<typeof hub>, count: number): Promise<void> {
	const ops = await Promise.all(Array.from({ length: count }, (_, i) => observationOp(String(i + 1))));
	const pushed = await stub.pushOps("dev-a", ops);
	if ("refused" in pushed) throw new Error(`unexpected refusal: ${pushed.error}`);
}

/**
 * Rows SQLite actually read while `run` executed. Wraps the object's own
 * SqlStorage, so it measures the production statements rather than SQL
 * composed by the test.
 */
function rowsReadDuring(state: DurableObjectState, run: () => void): number {
	const sql = state.storage.sql as unknown as {
		exec: (...args: unknown[]) => { rowsRead: number };
	};
	const original = sql.exec;
	const cursors: Array<{ rowsRead: number }> = [];
	sql.exec = (...args: unknown[]) => {
		const cursor = original.apply(sql, args);
		cursors.push(cursor);
		return cursor;
	};
	try {
		run();
	} finally {
		sql.exec = original;
	}
	return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
}

/**
 * The planner's chosen strategy for a statement, as one string. Assertions
 * match `SCAN canonical_ops` rather than bare `SCAN`: an EXISTS probe plans as
 * `SCAN CONSTANT ROW` for its trivial outer select, which is not a table scan.
 */
function planOf(state: DurableObjectState, sql: string, ...bindings: string[]): string {
	return state.storage.sql
		.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...bindings)
		.toArray()
		.map((row) => row.detail)
		.join(" | ");
}

describe("canonical_ops seq-ordering index", () => {
	it("serves every range query as an index seek, never a table scan", async () => {
		const stub = hub("seq-order-plan");
		for (let i = 1; i <= 12; i += 1) {
			await stub.pushOps("dev-a", [await observationOp(String(i))]);
		}

		await runInDurableObject(stub, (_instance: SyncHub, state) => {
			const expression = SEQ_ORDER;
			const cursor = seqKey("7");

			// The getChanges / fanOutCommitted shape.
			const page = planOf(
				state,
				`SELECT seq FROM canonical_ops WHERE ${expression} > ?
				 ORDER BY ${expression} LIMIT 500`,
				cursor,
			);
			expect(page).toContain("canonical_ops_seq_order");
			expect(page).not.toMatch(/SCAN canonical_ops\b/);
			expect(page).not.toContain("TEMP B-TREE");

			// The getProjectionPage two-sided shape.
			const range = planOf(
				state,
				`SELECT seq FROM canonical_ops WHERE ${expression} > ? AND ${expression} <= ?
				 ORDER BY ${expression} LIMIT 100`,
				cursor,
				seqKey("11"),
			);
			expect(range).toContain("canonical_ops_seq_order");
			expect(range).not.toMatch(/SCAN canonical_ops\b/);

			// fanOutCommitted's size probe, which reads bodies but must still seek.
			const stats = planOf(
				state,
				`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS body_len
				 FROM canonical_ops WHERE ${expression} > ?`,
				cursor,
			);
			expect(stats).toContain("canonical_ops_seq_order");
			expect(stats).not.toMatch(/SCAN canonical_ops\b/);

			// fanOutCommitted's unbounded fetch.
			const fanOut = planOf(
				state,
				`SELECT seq, body, operation_sha256, server_ts FROM canonical_ops
				 WHERE ${expression} > ? ORDER BY ${expression}`,
				cursor,
			);
			expect(fanOut).toContain("canonical_ops_seq_order");
			expect(fanOut).not.toMatch(/SCAN canonical_ops\b/);
			expect(fanOut).not.toContain("TEMP B-TREE");

			// getChanges' "more" probe.
			const more = planOf(
				state,
				`SELECT EXISTS(SELECT 1 FROM canonical_ops WHERE ${expression} > ?) AS n`,
				cursor,
			);
			expect(more).toContain("canonical_ops_seq_order");
			expect(more).not.toMatch(/SCAN canonical_ops\b/);
		});
	});

	// The plan assertions above run SQL the test composes. These run the real
	// methods and count the rows they read, so they catch a production query
	// that stops using the index even if every composed statement still does.
	it("reads a bounded number of rows per poll, independent of log size", async () => {
		const stub = hub("seq-order-rows-poll");
		await seedOps(stub, 300);
		const read = await runInDurableObject(stub, (instance: SyncHub, state) =>
			rowsReadDuring(state, () => {
				instance.getChanges("dev-reader", "295", 500);
			}),
		);
		// Five ops follow the cursor. A full scan would read all 300 rows,
		// twice: once for the page, once for the "more" probe.
		expect(read).toBeLessThan(40);
	});

	it("reads a bounded number of rows per status probe", async () => {
		const stub = hub("seq-order-rows-status");
		await seedOps(stub, 300);
		const read = await runInDurableObject(stub, (instance: SyncHub, state) =>
			rowsReadDuring(state, () => {
				instance.getStatus("dev-a");
			}),
		);
		// op_count comes from meta; a COUNT(*) over the log would read all 300.
		expect(read).toBeLessThan(40);
	});

	it("pages in numeric order across the decimal width change", async () => {
		const stub = hub("seq-order-width");
		for (let i = 1; i <= 12; i += 1) {
			await stub.pushOps("dev-a", [await observationOp(String(i))]);
		}
		// Lexicographic ordering would stop after "9"; numeric ordering must not.
		const page = await stub.getChanges("dev-reader", "7", 500);
		if ("refused" in page) throw new Error("unexpected refusal");
		expect(page.ops.map((op) => op.seq)).toEqual(["8", "9", "10", "11", "12"]);
		expect(page.more).toBe(false);
	});
});

describe("op_count without a per-probe COUNT(*)", () => {
	it("seeds from existing rows when the counter is absent, then tracks pushes", async () => {
		const stub = hub("op-count-seed");
		for (let i = 1; i <= 5; i += 1) {
			await stub.pushOps("dev-a", [await observationOp(String(i))]);
		}
		// An object written before op_count existed has rows but no counter.
		await runInDurableObject(stub, (instance: SyncHub, state) => {
			state.storage.sql.exec("DELETE FROM meta WHERE k = 'op_count'");
			(instance as unknown as { seedOpCount(): void }).seedOpCount();
		});
		const seeded = await stub.getStatus("dev-a");
		if ("refused" in seeded) throw new Error("unexpected refusal");
		expect(seeded.op_count).toBe(5);

		await stub.pushOps("dev-a", [await observationOp("6")]);
		const after = await stub.getStatus("dev-a");
		if ("refused" in after) throw new Error("unexpected refusal");
		expect(after.op_count).toBe(6);
	});

	it("does not count an idempotent re-push", async () => {
		const stub = hub("op-count-replay");
		const op = await observationOp("1");
		await stub.pushOps("dev-a", [op]);
		await stub.pushOps("dev-a", [op]);
		await stub.pushOps("dev-a", [op]);
		const status = await stub.getStatus("dev-a");
		if ("refused" in status) throw new Error("unexpected refusal");
		expect(status.op_count).toBe(1);
		expect(status.head_seq).toBe("1");
	});
});
