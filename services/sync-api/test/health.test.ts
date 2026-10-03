import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { DEFAULT_DATABASE_URL, trackedApp, waitUntil } from "./helpers";

describe("GET /health", () => {
	it("returns 200 as a liveness check", async () => {
		const { app } = await trackedApp();
		const res = await fetch(`${app.url}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("rejects non-GET", async () => {
		const { app } = await trackedApp();
		const res = await fetch(`${app.url}/health`, { method: "POST" });
		expect(res.status).toBe(405);
	});

	// Regression: /health pinged Postgres through the shared 10-connection pool.
	// When slow queries held every connection, the ping queued past Fly's 5s
	// check timeout and Fly pulled the only machine ("no healthy instances").
	it("answers while every pooled connection is held", async () => {
		const { app } = await trackedApp();
		const releaseConnections = Promise.withResolvers<void>();
		const heldConnections = Array.from({ length: 10 }, () =>
			app.sql.begin(async (tx) => {
				await tx`SELECT 'health-test-held-connection' AS marker`;
				await releaseConnections.promise;
			}));
		const observer = postgres(DEFAULT_DATABASE_URL, { max: 1 });
		try {
			await waitUntil(async () => {
				const [row] = await observer<{ held: number }[]>`
					SELECT COUNT(*)::int AS held FROM pg_stat_activity
					WHERE state = 'idle in transaction' AND query LIKE '%health-test-held-connection%'
				`;
				return row.held === 10;
			}, "all ten pooled connections to be held");

			const startedAt = performance.now();
			const res = await fetch(`${app.url}/health`, { signal: AbortSignal.timeout(2_000) });
			expect(res.status).toBe(200);
			expect(performance.now() - startedAt).toBeLessThan(1_000);
		} finally {
			releaseConnections.resolve();
			await Promise.all(heldConnections);
			await observer.end();
		}
	});
});
