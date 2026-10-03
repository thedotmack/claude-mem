import { describe, expect, it } from "bun:test";
import postgres from "postgres";
import { DEFAULT_SYNC_API_TIMEOUTS } from "../src/index";
import {
	authHeaders,
	DEFAULT_DATABASE_URL,
	observationOp,
	pushRequest,
	trackedApp,
	uniqueUser,
	waitUntil,
} from "./helpers";

/** Another process (or a slow request) holding a user's per-user advisory lock. */
async function holdUserLock(userId: string): Promise<postgres.Sql> {
	const holder = postgres(DEFAULT_DATABASE_URL, { max: 1 });
	await holder`SELECT pg_advisory_lock(hashtextextended(${userId}, 0))`;
	return holder;
}

async function appSessionsWaitingOnAdvisoryLock(observer: postgres.Sql): Promise<number> {
	const [row] = await observer<{ waiting: number }[]>`
		SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
		WHERE application_name = 'cmem-sync-api' AND wait_event_type = 'Lock' AND wait_event = 'advisory'
	`;
	return row.waiting;
}

async function deviceCursor(observer: postgres.Sql, userId: string, deviceId: string): Promise<string> {
	const [row] = await observer<{ last_ack_seq: string }[]>`
		SELECT last_ack_seq FROM sync_devices WHERE user_id = ${userId} AND device_id = ${deviceId}
	`;
	return row.last_ack_seq;
}

describe("per-user lock holds", () => {
	// Regression: pulls and status ran inside the per-user write transaction,
	// so every read queued behind the user's slowest work while holding a
	// pooled connection.
	it("serves pulls and status without waiting for a held per-user lock", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		expect((await pushRequest(app, userId, "dev-a", [await observationOp("1", "1", "dev-a")])).status).toBe(200);
		expect((await fetch(`${app.url}/v1/sync/changes?since=0`, { headers: authHeaders(userId, "dev-b") })).status).toBe(200);

		const holder = await holdUserLock(userId);
		try {
			const startedAt = performance.now();
			const changes = await fetch(`${app.url}/v1/sync/changes?since=0`, {
				headers: authHeaders(userId, "dev-b"),
				signal: AbortSignal.timeout(3_000),
			});
			expect(changes.status).toBe(200);
			const page = await changes.json() as { ops: Array<{ seq: string }>; head_seq: string; more: boolean };
			expect(page.ops.map((op) => op.seq)).toEqual(["1"]);
			expect(page.head_seq).toBe("1");
			expect(page.more).toBe(false);

			const status = await fetch(`${app.url}/v1/sync/status`, {
				headers: authHeaders(userId, "dev-b"),
				signal: AbortSignal.timeout(3_000),
			});
			expect(status.status).toBe(200);
			expect((await status.json() as { head_seq: string; device_count: number })).toMatchObject({
				head_seq: "1",
				device_count: 2,
			});
			expect(performance.now() - startedAt).toBeLessThan(2_000);
		} finally {
			await holder.end();
		}
	});

	it("records each pull's cursor monotonically without the per-user lock", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const ops = [await observationOp("1", "1", "dev-a"), await observationOp("2", "1", "dev-a")];
		expect((await pushRequest(app, userId, "dev-a", ops)).status).toBe(200);
		const observer = postgres(DEFAULT_DATABASE_URL, { max: 1 });
		const holder = await holdUserLock(userId);
		try {
			const pull = (since: string) => fetch(`${app.url}/v1/sync/changes?since=${since}`, {
				headers: authHeaders(userId, "dev-a"),
				signal: AbortSignal.timeout(3_000),
			});
			expect((await pull("2")).status).toBe(200);
			expect(await deviceCursor(observer, userId, "dev-a")).toBe("2");
			expect((await pull("0")).status).toBe(200);
			expect(await deviceCursor(observer, userId, "dev-a")).toBe("2");
			// A cursor past head is clamped to head, as before.
			expect((await pull("99")).status).toBe(200);
			expect(await deviceCursor(observer, userId, "dev-a")).toBe("2");
		} finally {
			await holder.end();
			await observer.end();
		}
	});

	// Regression: requests for one user each held a pooled connection while
	// waiting on that user's advisory lock, so one user's backlog could fill
	// the pool and stall every other user (and the old DB-backed /health).
	it("queues same-user writes in-process so one user's backlog holds at most one pooled connection", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const ops = await Promise.all(Array.from({ length: 6 }, (_, index) => observationOp(String(index + 1), "1", "dev-a")));
		const observer = postgres(DEFAULT_DATABASE_URL, { max: 1 });
		const holder = await holdUserLock(userId);
		const pushes = ops.map((op) => pushRequest(app, userId, "dev-a", [op]));
		try {
			await waitUntil(async () => (await appSessionsWaitingOnAdvisoryLock(observer)) >= 1, "a push to reach the advisory lock");
			await Bun.sleep(300);
			expect(await appSessionsWaitingOnAdvisoryLock(observer)).toBe(1);

			const otherUser = uniqueUser();
			const other = await pushRequest(app, otherUser, "dev-a", [await observationOp("1", "1", "dev-a")], {
				signal: AbortSignal.timeout(3_000),
			});
			expect(other.status).toBe(200);
		} finally {
			await holder.end();
		}
		// Every push commits once its turn comes. Pushes whose projection drain
		// finds another push's drain holding the lease answer the existing
		// durable "projection_busy" 503, exactly as concurrent pushes did before.
		const bodies = await Promise.all(pushes.map(async (pending) => {
			const res = await pending;
			const body = await res.json() as { head_seq: string; error?: string; durable?: boolean };
			if (res.status !== 200) expect([res.status, body.error, body.durable]).toEqual([503, "projection_busy", true]);
			return body;
		}));
		expect(bodies.map((body) => body.head_seq).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
		await observer.end();
	});

	it("turns a stuck lock holder into retryable 503s instead of hung requests", async () => {
		const { app } = await trackedApp({ ...DEFAULT_SYNC_API_TIMEOUTS, lockTimeoutMs: 500, userTurnMaxWaitMs: 300 });
		const userId = uniqueUser();
		const holder = await holdUserLock(userId);
		try {
			const startedAt = performance.now();
			const [atLock, inQueue] = await Promise.all([
				pushRequest(app, userId, "dev-a", [await observationOp("1", "1", "dev-a")]),
				pushRequest(app, userId, "dev-a", [await observationOp("2", "1", "dev-a")]),
			]);
			expect(performance.now() - startedAt).toBeLessThan(3_000);
			for (const res of [atLock, inQueue]) {
				expect(res.status).toBe(503);
				expect(res.headers.get("Retry-After")).toBe("5");
				expect(await res.json()).toEqual({ error: "sync_hub_unavailable", retryable: true });
			}
		} finally {
			await holder.end();
		}
		expect((await pushRequest(app, userId, "dev-a", [await observationOp("1", "1", "dev-a")])).status).toBe(200);
	});

	it("ends a stalled transaction so it cannot keep holding a user's lock", async () => {
		const { app } = await trackedApp({ ...DEFAULT_SYNC_API_TIMEOUTS, idleInTransactionSessionTimeoutMs: 300 });
		const userId = uniqueUser();
		// Stuck forever on non-DB work while holding the lock. (It must never
		// query again: postgres.js would write to the closed socket and crash.)
		const stalled = app.sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
			await new Promise<never>(() => {});
		}).then(() => "committed", (error: { code?: string }) => error.code);
		await Bun.sleep(50);
		const push = await pushRequest(app, userId, "dev-a", [await observationOp("1", "1", "dev-a")], {
			signal: AbortSignal.timeout(5_000),
		});
		expect(push.status).toBe(200);
		expect(await stalled).toBe("CONNECTION_CLOSED");
	});

	it("drops a queued write whose client disconnected before its turn", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const [firstOp, abandonedOp] = [await observationOp("1", "1", "dev-a"), await observationOp("2", "1", "dev-a")];
		const observer = postgres(DEFAULT_DATABASE_URL, { max: 1 });
		const holder = await holdUserLock(userId);
		const abandoned = new AbortController();
		const first = pushRequest(app, userId, "dev-a", [firstOp]);
		try {
			await waitUntil(async () => (await appSessionsWaitingOnAdvisoryLock(observer)) === 1, "the first push to reach the lock");
			const second = pushRequest(app, userId, "dev-a", [abandonedOp], { signal: abandoned.signal })
				.catch((error: Error) => error.name);
			await Bun.sleep(300);
			abandoned.abort();
			expect(await second).toBe("AbortError");
			await Bun.sleep(100);
		} finally {
			await holder.end();
			await observer.end();
		}
		expect((await first).status).toBe(200);
		const changes = await fetch(`${app.url}/v1/sync/changes?since=0`, { headers: authHeaders(userId, "dev-a") });
		const page = await changes.json() as { ops: unknown[]; head_seq: string };
		expect(page.head_seq).toBe("1");
		expect(page.ops).toHaveLength(1);
		expect((await pushRequest(app, userId, "dev-a", [await observationOp("3", "1", "dev-a")])).status).toBe(200);
	});
});
