import { afterAll, describe, expect, it } from "bun:test";
import type { AuthDependencies } from "../src/auth";
import { AUTH_EXPIRED_CLOSE_CODE } from "../src/sockets";
import { authHeaders, observationOp, trackedApp, uniqueUser, waitUntil, stopTrackedApps } from "./helpers";

afterAll(stopTrackedApps);

describe("advisory WebSocket", () => {
	it("closes a socket whose verdict lapsed instead of feeding it committed ops", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const wsUrl = app.url.replace(/^http/, "ws") + "/v1/sync/ws";

		const replica = new WebSocket(wsUrl, {
			headers: { ...authHeaders(userId, "dev-b"), Upgrade: "websocket" },
		});
		const frames: string[] = [];
		replica.addEventListener("message", (event) => frames.push(String(event.data)));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("ws open timed out")), 5_000);
			replica.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			replica.addEventListener("error", () => reject(new Error("ws failed")));
		});
		const closedCode = new Promise<number>((resolve) => {
			replica.addEventListener("close", (event) => resolve(event.code));
		});
		await waitUntil(async () => app.sockets.forUser(userId).length === 1, "socket registration");

		// Expire the verdict the way time would, then push from another device:
		// the fan-out must close this socket (4401) instead of feeding it.
		app.sockets.forUser(userId)[0].authExpiresAtMs = Date.now() - 1;
		const op = await observationOp("1", "1", "dev-a");
		const push = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [op] }),
		});
		expect(push.status).toBe(200);
		expect(await closedCode).toBe(AUTH_EXPIRED_CLOSE_CODE);
		expect(frames).toHaveLength(0);
	});

	it("closes a quiet socket at its verdict's deadline without any fan-out", async () => {
		// A cached verdict with ~150ms left: no upstream verify, and no push is
		// made below, so only the socket's own deadline timer can close it.
		const auth: AuthDependencies = {
			async readCachedVerdict() { return String(Date.now() + 150); },
			async cacheVerifiedVerdict() {},
			async invalidateCachedVerdict() {},
			async verifyToken() { throw new Error("a cached verdict must not be re-verified"); },
			logCacheFailure() {},
		};
		const { app } = await trackedApp(undefined, auth);
		const userId = uniqueUser();
		const wsUrl = app.url.replace(/^http/, "ws") + "/v1/sync/ws";

		const replica = new WebSocket(wsUrl, {
			headers: { ...authHeaders(userId, "dev-b"), Upgrade: "websocket" },
		});
		const frames: string[] = [];
		replica.addEventListener("message", (event) => frames.push(String(event.data)));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("ws open timed out")), 5_000);
			replica.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			replica.addEventListener("error", () => reject(new Error("ws failed")));
		});
		const closedCode = new Promise<number>((resolve) => {
			replica.addEventListener("close", (event) => resolve(event.code));
		});

		expect(await closedCode).toBe(AUTH_EXPIRED_CLOSE_CODE);
		expect(frames).toHaveLength(0);
	});
});
