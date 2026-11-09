import { describe, expect, it } from "bun:test";
import { drainProjection } from "../src/projection";
import { PROJECTION_LEASE_MS, type HubStore, type PushOp } from "../src/store";
import { observationOp, pushRequest, trackedApp, uniqueUser } from "./helpers";

async function pushTwo(store: HubStore, userId: string): Promise<string> {
	const ops = [await observationOp("1", "1", "dev-a"), await observationOp("2", "1", "dev-a")] as PushOp[];
	const result = await store.pushOps(userId, "dev-a", ops, null);
	if ("refused" in result) throw new Error(result.error);
	return result.head_seq;
}

/** The real store, with one-op pages so a two-op target needs two pages. */
function onePagePerOp(store: HubStore, overrides: Partial<HubStore> = {}): HubStore {
	const wrapper = Object.create(store) as HubStore;
	wrapper.getProjectionPage = (userId, token, targetSeq, projectionUserId, _maxOps, maxBytes, now) =>
		store.getProjectionPage(userId, token, targetSeq, projectionUserId, 1, maxBytes, now);
	return Object.assign(wrapper, overrides);
}

async function leaseIsFree(store: HubStore, userId: string, targetSeq: string): Promise<boolean> {
	const lease = await store.acquireProjectionLease(userId, targetSeq);
	if (lease.acquired && lease.lease_token) await store.releaseProjectionLease(userId, lease.lease_token);
	return lease.acquired;
}

describe("projection lease after a drain stops", () => {
	it("hands the lease to the next push when the client leaves between pages", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const head = await pushTwo(app.store, userId);
		const client = new AbortController();
		const store = onePagePerOp(app.store, {
			advanceProjectionCheckpoint: async (...args: Parameters<HubStore["advanceProjectionCheckpoint"]>) => {
				const state = await app.store.advanceProjectionCheckpoint(...args);
				client.abort();
				return state;
			},
		});

		const result = await drainProjection(app.env, store, userId, head, { clientSignal: client.signal });

		expect(result).toMatchObject({ ok: false, error: "projection_client_disconnected", projectedSeq: "1" });
		expect((await app.store.getProjectionState(userId)).projected_seq).toBe("1");
		expect(await leaseIsFree(app.store, userId, head)).toBe(true);
	});

	it("takes no lease for a client that already left", async () => {
		const { app, sidecar } = await trackedApp();
		const userId = uniqueUser();
		const head = await pushTwo(app.store, userId);
		const calls = sidecar.state.projectionCalls.length;

		const result = await drainProjection(app.env, app.store, userId, head, { clientSignal: AbortSignal.abort() });

		expect(result).toMatchObject({ ok: false, error: "projection_client_disconnected", projectedSeq: "0" });
		expect(sidecar.state.projectionCalls.length).toBe(calls);
		expect(await leaseIsFree(app.store, userId, head)).toBe(true);
	});

	it("releases the lease when the first page fails before anything is sent", async () => {
		const { app, sidecar } = await trackedApp();
		const userId = uniqueUser();
		const head = await pushTwo(app.store, userId);
		const calls = sidecar.state.projectionCalls.length;
		const store = onePagePerOp(app.store, {
			getProjectionPage: async () => { throw new Error("simulated page read failure"); },
		});

		const result = await drainProjection(app.env, store, userId, head);

		expect(result).toMatchObject({ ok: false, error: "simulated page read failure", retryable: true });
		expect(sidecar.state.projectionCalls.length).toBe(calls);
		expect(await leaseIsFree(app.store, userId, head)).toBe(true);
	});

	it("keeps the lease when a sent page's outcome is unknown", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const head = await pushTwo(app.store, userId);

		const result = await drainProjection(app.env, app.store, userId, head, {
			fetchImpl: async () => { throw new Error("simulated network reset"); },
		});

		expect(result).toMatchObject({ ok: false, error: "projection_upstream_unreachable" });
		expect(await leaseIsFree(app.store, userId, head)).toBe(false);
	});

	it("tells a push that hits a held lease when to retry", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const head = await pushTwo(app.store, userId);
		const held = await app.store.acquireProjectionLease(userId, head);
		expect(held.acquired).toBe(true);

		const res = await pushRequest(app, userId, "dev-a", [await observationOp("3", "1", "dev-a")]);
		const body = await res.json() as { error: string; durable: boolean };

		expect([res.status, body.error, body.durable]).toEqual([503, "projection_busy", true]);
		// Durable but not projected: no per-op acks, so the client stamps nothing.
		expect(body).not.toHaveProperty("acked");
		const retryAfter = Number(res.headers.get("Retry-After"));
		expect(Number.isInteger(retryAfter)).toBe(true);
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(Math.ceil(PROJECTION_LEASE_MS / 1000));
		await app.store.releaseProjectionLease(userId, held.lease_token!);
	});
});
