import { describe, expect, it } from "bun:test";
import { incrementCanonicalDecimal } from "../src/canonical-content";
import { MAX_DEVICES_PER_USER } from "../src/store";
import { authHeaders, observationOp, trackedApp, uniqueUser } from "./helpers";

describe("protocol v2 hub", () => {
	it("starts a new user on a fresh epoch with an empty log", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const res = await fetch(`${app.url}/v1/sync/status`, { headers: authHeaders(userId) });
		expect(res.status).toBe(200);
		const status = await res.json() as {
			protocol_version: number;
			epoch: string;
			head_seq: string;
			projected_seq: string;
			op_count: number;
			device_count: number;
		};
		expect(status.protocol_version).toBe(2);
		expect(status.head_seq).toBe("0");
		expect(status.projected_seq).toBe("0");
		expect(status.op_count).toBe(0);
		expect(status.device_count).toBe(0);
		expect(status.epoch).toMatch(/^[1-9][0-9]*$/);
		expect(status.epoch).not.toBe("0");
	});

	it("assigns dense seq, projects inside the push, and re-acks an identical rev", async () => {
		const { app, sidecar } = await trackedApp();
		const userId = uniqueUser();
		const deviceId = "dev-a";
		const op = await observationOp("1", "1", deviceId);
		const push = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [op] }),
		});
		expect(push.status).toBe(200);
		const body = await push.json() as {
			acked: Array<{ seq: string }>;
			head_seq: string;
			projected_seq: string;
		};
		expect(body.acked).toHaveLength(1);
		expect(body.acked[0].seq).toBe("1");
		expect(body.head_seq).toBe("1");
		expect(body.projected_seq).toBe("1");
		expect(sidecar.state.projectionCalls).toHaveLength(1);

		const again = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [op] }),
		});
		expect(again.status).toBe(200);
		const acked = await again.json() as { acked: Array<{ seq: string }>; head_seq: string };
		expect(acked.acked[0].seq).toBe("1");
		expect(acked.head_seq).toBe("1");

		const changes = await fetch(`${app.url}/v1/sync/changes?since=0`, {
			headers: authHeaders(userId, "dev-b"),
		});
		expect(changes.status).toBe(200);
		const page = await changes.json() as { ops: unknown[]; head_seq: string; more: boolean; protocol_version: number };
		expect(page.protocol_version).toBe(2);
		expect(page.ops).toHaveLength(1);
		expect(page.head_seq).toBe("1");
		expect(page.more).toBe(false);
	});

	it("refuses a stale revision and a same-rev hash conflict", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const deviceId = "dev-a";
		const first = await observationOp("7", "2", deviceId);
		expect((await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [first] }),
		})).status).toBe(200);

		const stale = await observationOp("7", "1", deviceId);
		const staleRes = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [stale] }),
		});
		expect(staleRes.status).toBe(400);
		expect((await staleRes.json() as { error: string }).error).toContain("stale_revision");

		const conflict = await observationOp("7", "2", deviceId, { text: "different" });
		const conflictRes = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [conflict] }),
		});
		expect(conflictRes.status).toBe(400);
		expect((await conflictRes.json() as { error: string }).error).toContain("revision_hash_conflict");
	});

	it("accepts an empty push and never answers 200 with a lagging checkpoint", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const res = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [] }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { acked: unknown[]; head_seq: string; projected_seq: string };
		expect(body.acked).toEqual([]);
		expect(body.head_seq).toBe("0");
		expect(body.projected_seq).toBe("0");
	});

	it("increments the full uint64 decimal range without JS-number coercion", () => {
		expect(incrementCanonicalDecimal("9007199254740991")).toBe("9007199254740992");
		expect(incrementCanonicalDecimal("9223372036854775807")).toBe("9223372036854775808");
	});

	it("enforces the 64-device first-name-wins cap", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
			const res = await fetch(`${app.url}/v1/sync/status`, {
				headers: authHeaders(userId, `device-${i}`),
			});
			// status with an unseen device does not register; register via changes.
			const changes = await fetch(`${app.url}/v1/sync/changes?since=0`, {
				headers: authHeaders(userId, `device-${i}`),
			});
			expect(changes.status).toBe(200);
			expect(res.status).toBe(200);
		}
		const overflow = await fetch(`${app.url}/v1/sync/changes?since=0`, {
			headers: authHeaders(userId, "device-overflow"),
		});
		expect(overflow.status).toBe(409);
		expect((await overflow.json() as { error: string }).error).toContain("device_limit_exceeded");
	});

	it("resets one user to a new empty epoch", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const deviceId = "dev-a";
		const op = await observationOp("3", "1", deviceId);
		expect((await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [op] }),
		})).status).toBe(200);

		const reset = await fetch(`${app.url}/internal/v1/sync/reset`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-projector-secret",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ protocol_version: 1, user_id: userId }),
		});
		expect(reset.status).toBe(200);
		const wiped = await reset.json() as { epoch: string; head_seq: string };
		expect(wiped.head_seq).toBe("0");
		expect(wiped.epoch).toMatch(/^[1-9][0-9]*$/);

		const status = await fetch(`${app.url}/v1/sync/status`, { headers: authHeaders(userId) });
		const body = await status.json() as { head_seq: string; epoch: string; device_count: number };
		expect(body.head_seq).toBe("0");
		expect(body.epoch).toBe(wiped.epoch);
		expect(body.device_count).toBe(0);
	});
});
