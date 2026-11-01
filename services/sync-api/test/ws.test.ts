import { describe, expect, it } from "bun:test";
import { authHeaders, observationOp, trackedApp, uniqueUser } from "./helpers";

describe("advisory WebSocket", () => {
	it("answers ping with pong and fans out an op frame to the other device", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const wsUrl = app.url.replace(/^http/, "ws") + "/v1/sync/ws";

		const a = new WebSocket(wsUrl, {
			headers: { ...authHeaders(userId, "dev-a"), Upgrade: "websocket" },
		});
		const b = new WebSocket(wsUrl, {
			headers: { ...authHeaders(userId, "dev-b"), Upgrade: "websocket" },
		});
		const frames: string[] = [];
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("ws open timed out")), 5_000);
			let opened = 0;
			const onOpen = () => {
				opened += 1;
				if (opened === 2) {
					clearTimeout(timer);
					resolve();
				}
			};
			a.addEventListener("open", onOpen);
			b.addEventListener("open", onOpen);
			a.addEventListener("error", () => reject(new Error("ws a failed")));
			b.addEventListener("error", () => reject(new Error("ws b failed")));
		});
		b.addEventListener("message", (event) => {
			frames.push(String(event.data));
		});

		a.send("ping");
		const pongs: string[] = [];
		a.addEventListener("message", (event) => pongs.push(String(event.data)));
		const pongDeadline = Date.now() + 2_000;
		while (Date.now() < pongDeadline && !pongs.includes("pong")) {
			await Bun.sleep(20);
		}
		expect(pongs).toContain("pong");

		const op = await observationOp("1", "1", "dev-a");
		const push = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [op] }),
		});
		expect(push.status).toBe(200);

		const frameDeadline = Date.now() + 2_000;
		while (Date.now() < frameDeadline && frames.length === 0) {
			await Bun.sleep(20);
		}
		expect(frames.length).toBeGreaterThan(0);
		const parsed = JSON.parse(frames[0]) as { type: string; epoch?: string };
		expect(["op", "advance"]).toContain(parsed.type);

		a.close();
		b.close();
	});

	it("rejects a missing upgrade header", async () => {
		const { app } = await trackedApp();
		const res = await fetch(`${app.url}/v1/sync/ws`, {
			headers: authHeaders(uniqueUser(), "dev-a"),
		});
		expect(res.status).toBe(426);
	});
});
