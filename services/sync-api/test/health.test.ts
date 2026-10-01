import { describe, expect, it } from "bun:test";
import { trackedApp } from "./helpers";

describe("GET /health", () => {
	it("returns 200 after a successful database ping", async () => {
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
});
