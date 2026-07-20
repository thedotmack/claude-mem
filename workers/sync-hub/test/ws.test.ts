import { env, evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	DEVICE_LIMIT_ERROR,
	MAX_DEVICES_PER_USER,
	type ChangesOutcome,
	type ChangesResult,
	type PushOutcome,
	type PushResult,
} from "../src/do/SyncHub";
import { KILL_SWITCH_KEY } from "../src/kill-switch";
import { observationOp } from "./content-v2-helpers";

const base = "https://sync-hub.test";

interface OpFrame {
	type: "op";
	epoch: string;
	ops: Array<{
		seq: string;
		body: string;
		operation_sha256: string;
		server_ts: string;
	}>;
}

interface AdvanceFrame {
	type: "advance";
	epoch: string;
	head_seq: string;
}

function headers(userId: string, deviceId: string): Record<string, string> {
	return {
		Authorization: `Bearer valid-for:${userId}`,
		"X-User-Id": userId,
		"X-Device-Id": deviceId,
	};
}

function ok(outcome: PushOutcome): PushResult {
	if ("refused" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return outcome;
}

function changes(outcome: ChangesOutcome): ChangesResult {
	if ("refused" in outcome) throw new Error(`unexpected refusal: ${outcome.error}`);
	return outcome;
}

interface Connected {
	ws: WebSocket;
	messages: string[];
}

async function connect(userId: string, deviceId: string): Promise<Connected> {
	const response = await SELF.fetch(`${base}/v1/sync/ws`, {
		headers: { ...headers(userId, deviceId), Upgrade: "websocket" },
	});
	expect(response.status).toBe(101);
	const ws = response.webSocket!;
	const messages: string[] = [];
	ws.accept();
	ws.addEventListener("message", (event) => {
		messages.push(String(event.data));
	});
	return { ws, messages };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("upgrade and auth", () => {
	it("upgrades an authenticated request and auto-responds to ping", async () => {
		const { ws, messages } = await connect("user-ws-upgrade", "dev-a");
		ws.send("ping");
		await waitFor(() => messages.includes("pong"), "pong");
		ws.close();
	});

	it("rejects missing credentials and non-upgrade requests", async () => {
		const unauthenticated = await SELF.fetch(`${base}/v1/sync/ws`, { headers: { Upgrade: "websocket" } });
		expect(unauthenticated.status).toBe(401);
		const notUpgrade = await SELF.fetch(`${base}/v1/sync/ws`, { headers: headers("user-ws-426", "dev-a") });
		expect(notUpgrade.status).toBe(426);
	});

	it("rejects a 65th WebSocket device but still upgrades an existing device", async () => {
		const user = "user-ws-device-cap";
		for (let index = 0; index < MAX_DEVICES_PER_USER; index++) {
			const response = await SELF.fetch(`${base}/v1/sync/changes?since=0`, {
				headers: headers(user, `dev-${index}`),
			});
			expect(response.status).toBe(200);
		}
		const rejected = await SELF.fetch(`${base}/v1/sync/ws`, {
			headers: { ...headers(user, "dev-new"), Upgrade: "websocket" },
		});
		expect(rejected.status).toBe(409);
		expect(await rejected.json()).toEqual({ error: DEVICE_LIMIT_ERROR });

		const existing = await connect(user, "dev-0");
		existing.ws.close();
	});
});

describe("canonical advisory fan-out", () => {
	it("sends canonical committed ops to replicas and excludes the origin device", async () => {
		const user = "user-ws-fanout-v2";
		const origin = await connect(user, "dev-a");
		const replica = await connect(user, "dev-b");
		const ops = [await observationOp("1"), await observationOp("2")];
		const response = await SELF.fetch(`${base}/v1/sync/ops`, {
			method: "POST",
			headers: { ...headers(user, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops }),
		});
		expect(response.status).toBe(200);
		const acked = (await response.json() as { acked: Array<{ seq: string }> }).acked;
		await waitFor(() => replica.messages.length === 1, "replica op frame");
		const frame = JSON.parse(replica.messages[0]) as OpFrame;
		expect(frame.type).toBe("op");
		expect(frame.ops.map((op) => op.seq)).toEqual(acked.map((item) => item.seq));
		expect(frame.ops.map((op) => JSON.parse(op.body).origin_local_id)).toEqual(["1", "2"]);
		expect(frame.ops.every((op) => typeof op.operation_sha256 === "string")).toBe(true);
		expect(frame.ops.every((op) => typeof op.server_ts === "string")).toBe(true);
		await settle();
		expect(origin.messages).toHaveLength(0);
		origin.ws.close();
		replica.ws.close();
	});

	it("falls back to advance for more than 100 ops", async () => {
		const user = "user-ws-advance-count-v2";
		const replica = await connect(user, "dev-b");
		const ops = await Promise.all(Array.from({ length: 101 }, (_, index) => observationOp(String(index + 1))));
		const result = ok(await env.SYNC_HUB.getByName(user).pushOps("dev-a", ops));
		await waitFor(() => replica.messages.length === 1, "advance frame");
		const frame = JSON.parse(replica.messages[0]) as AdvanceFrame;
		expect(frame).toMatchObject({ type: "advance", head_seq: result.head_seq });
		replica.ws.close();
	});

	it("falls back to advance when valid canonical bodies exceed the frame byte budget", async () => {
		const user = "user-ws-advance-bytes-v2";
		const replica = await connect(user, "dev-b");
		const ops = await Promise.all([
			observationOp("1", "1", "dev-a", { text: "x".repeat(140_000) }),
			observationOp("2", "1", "dev-a", { text: "y".repeat(140_000) }),
		]);
		const result = ok(await env.SYNC_HUB.getByName(user).pushOps("dev-a", ops));
		await waitFor(() => replica.messages.length === 1, "byte-budget advance frame");
		expect(JSON.parse(replica.messages[0])).toMatchObject({ type: "advance", head_seq: result.head_seq });
		replica.ws.close();
	});

	it("does not fan out a pure replay", async () => {
		const user = "user-ws-replay-v2";
		const stub = env.SYNC_HUB.getByName(user);
		const op = await observationOp("1");
		ok(await stub.pushOps("dev-a", [op]));
		const replica = await connect(user, "dev-b");
		ok(await stub.pushOps("dev-a", [op]));
		await settle();
		expect(replica.messages).toHaveLength(0);
		replica.ws.close();
	});

	it("survives hibernation and a closed socket cannot fail durable push", async () => {
		const user = "user-ws-hibernate-v2";
		const replica = await connect(user, "dev-b");
		const stub = env.SYNC_HUB.getByName(user);
		await evictDurableObject(stub, { webSockets: "hibernate" });
		ok(await stub.pushOps("dev-a", [await observationOp("1")]));
		await waitFor(() => replica.messages.length === 1, "post-hibernation frame");
		replica.ws.close();
		const result = ok(await stub.pushOps("dev-a", [await observationOp("2")]));
		expect(result.acked).toHaveLength(1);
		expect(changes(await stub.getChanges("dev-c", "0", 500)).ops).toHaveLength(2);
	});
});

describe("kill switch", () => {
	it("refuses upgrades in poll mode and recovers immediately after clear", async () => {
		await env.AUTH_CACHE.put(KILL_SWITCH_KEY, "1");
		try {
			const response = await SELF.fetch(`${base}/v1/sync/ws`, {
				headers: { ...headers("user-ws-kill", "dev-a"), Upgrade: "websocket" },
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("X-Sync-Mode")).toBe("poll");
		} finally {
			await env.AUTH_CACHE.delete(KILL_SWITCH_KEY);
		}
		const { ws } = await connect("user-ws-kill", "dev-a");
		ws.close();
	});
});
