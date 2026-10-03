import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { SocketRegistry } from "../src/sockets";
import { HubStore } from "../src/store";
import { DEFAULT_DATABASE_URL, uniqueUser } from "./helpers";

const SEEDED_OPS = 3_000;
const CURSOR = "2990";

interface PlanNode {
	"Node Type": string;
	"Index Name"?: string;
	"Index Cond"?: string;
	"Rows Removed by Filter"?: number;
	"Actual Rows"?: number;
	Plans?: PlanNode[];
}

function findIndexNode(node: PlanNode, indexName: string): PlanNode | undefined {
	if (node["Index Name"] === indexName) return node;
	for (const child of node.Plans ?? []) {
		const found = findIndexNode(child, indexName);
		if (found) return found;
	}
	return undefined;
}

function sqlLiteral(value: unknown): string {
	return typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
}

// Regression: the seq range was written as
//   length(seq) > length($n) OR (length(seq) = length($n) AND seq > $n)
// which btree cannot seek, so every incremental pull and projection page
// walked the user's whole log from seq 1 (Rows Removed by Filter: 73,000 and
// 12.7s on Neon for a cursor at 73,000). Row comparisons are index conditions.
describe("seq range queries", () => {
	it("seek the cursor through (user_id, length(seq), seq) instead of filtering the user's whole log", async () => {
		const userId = uniqueUser();
		const admin = postgres(DEFAULT_DATABASE_URL, { max: 1 });
		const captured: Array<{ query: string; parameters: unknown[] }> = [];
		const traced = postgres(DEFAULT_DATABASE_URL, {
			max: 1,
			debug: (_connection, query, parameters) => { captured.push({ query, parameters }); },
		});
		try {
			await admin`
				INSERT INTO sync_ops (user_id, seq, entity_id, kind, origin_device_id, origin_local_id,
				                      entity_rev, operation_sha256, body, deleted, server_ts)
				SELECT ${userId}, g::text, 'observation:seed-' || g, 'observation', 'dev-seed', g::text,
				       '1', 'seed-hash', '{"seed":' || g || '}', 0, '0'
				FROM generate_series(1, ${SEEDED_OPS}::int) AS g
			`;
			await admin`
				INSERT INTO sync_users (user_id, epoch, head_seq, projected_seq)
				VALUES (${userId}, '1', ${String(SEEDED_OPS)}, ${CURSOR})
			`;
			await admin`INSERT INTO sync_devices (user_id, device_id, last_ack_seq) VALUES (${userId}, 'dev-a', '0')`;

			const store = new HubStore(traced, new SocketRegistry());
			const changes = await store.getChanges(userId, "dev-a", CURSOR, 500);
			expect("ops" in changes && changes.ops.map((op) => op.seq)).toEqual(
				Array.from({ length: 10 }, (_, index) => String(2991 + index)),
			);
			const lease = await store.acquireProjectionLease(userId, String(SEEDED_OPS));
			const page = await store.getProjectionPage(userId, lease.lease_token ?? "", String(SEEDED_OPS), userId);
			expect(page.ops).toHaveLength(10);

			const rangeQueries = captured.filter(({ query }) =>
				query.includes("FROM sync_ops") && query.includes("ORDER BY length(seq), seq"));
			expect(rangeQueries).toHaveLength(2);

			// Production's planner picks the ordered (user_id, length(seq), seq) scan
			// for these ORDER BY ... LIMIT queries. A small test table can tempt it
			// into seq scan + sort instead, so take those options away: the property
			// under test is whether that scan seeks the seq bound or filters it.
			const explainWithOrderedIndexScan = (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
				admin.begin(async (tx) => {
					await tx`SET LOCAL enable_seqscan = off`;
					await tx`SET LOCAL enable_bitmapscan = off`;
					await tx`SET LOCAL enable_sort = off`;
					return run(tx);
				});
			for (const { query, parameters } of rangeQueries) {
				const custom = await explainWithOrderedIndexScan((tx) =>
					tx.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, parameters as never[]));
				const generic = await explainWithOrderedIndexScan(async (tx) => {
					await tx.unsafe(`PREPARE seq_range_probe AS ${query}`);
					await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
					const plan = await tx.unsafe(
						`EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE seq_range_probe(${parameters.map(sqlLiteral).join(", ")})`,
					);
					await tx.unsafe("DEALLOCATE seq_range_probe");
					return plan;
				});
				for (const explained of [custom, generic] as Array<Array<Record<string, unknown>>>) {
					const root = (explained[0]["QUERY PLAN"] as Array<{ Plan: PlanNode }>)[0].Plan;
					const scan = findIndexNode(root, "sync_ops_user_seq_order");
					if (!scan) throw new Error(`no sync_ops_user_seq_order scan in plan: ${JSON.stringify(root)}`);
					expect(scan["Index Cond"]).toContain("length(seq)");
					expect(scan["Rows Removed by Filter"] ?? 0).toBe(0);
					expect(scan["Actual Rows"]).toBeLessThanOrEqual(11);
				}
			}
		} finally {
			await admin`DELETE FROM sync_ops WHERE user_id = ${userId}`;
			await admin`DELETE FROM sync_devices WHERE user_id = ${userId}`;
			await admin`DELETE FROM sync_users WHERE user_id = ${userId}`;
			await traced.end();
			await admin.end();
		}
	});
});
