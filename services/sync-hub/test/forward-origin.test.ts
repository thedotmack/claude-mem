import { describe, expect, it } from "vitest";
import {
	buildForwardRequest,
	resolveForwardOrigin,
	rewriteForwardUrl,
} from "../src/index";

describe("FORWARD_ORIGIN proxy helpers", () => {
	it("treats an empty or whitespace-only value as unset", () => {
		expect(resolveForwardOrigin(undefined)).toBeNull();
		expect(resolveForwardOrigin("")).toBeNull();
		expect(resolveForwardOrigin("   ")).toBeNull();
	});

	it("rejects a configured value it cannot use instead of falling back", () => {
		expect(() => resolveForwardOrigin("not-a-url")).toThrow(/not a valid URL/);
		expect(() => resolveForwardOrigin("ftp://hub.example")).toThrow(/https/);
		expect(() => resolveForwardOrigin("http://sync.example")).toThrow(/https/);
	});

	it("normalizes a configured origin and strips trailing slashes or paths", () => {
		expect(resolveForwardOrigin("https://sync.cmem.ai")).toBe("https://sync.cmem.ai");
		expect(resolveForwardOrigin("https://sync.cmem.ai/")).toBe("https://sync.cmem.ai");
		expect(resolveForwardOrigin(" https://sync.example:8080/v1 ")).toBe("https://sync.example:8080");
	});

	it("refuses a cleartext forward origin unless the host is loopback", () => {
		expect(() => resolveForwardOrigin("http://sync.example")).toThrow(/https/);
		expect(() => resolveForwardOrigin("http://sync.example:8080")).toThrow(/https/);
		expect(resolveForwardOrigin("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
		expect(resolveForwardOrigin("http://localhost:8788")).toBe("http://localhost:8788");
		expect(resolveForwardOrigin("http://[::1]:8788")).toBe("http://[::1]:8788");
	});

	it("answers 500 when the forward origin is configured but unusable", async () => {
		const { default: worker } = await import("../src/index");
		const response = await worker.fetch(
			new Request("https://hub.example/v1/sync/ops", { method: "POST" }),
			{ FORWARD_ORIGIN: "http://sync.example" } as unknown as Env,
			{} as ExecutionContext,
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: expect.stringContaining("sync_hub_misconfigured"),
		});
	});

	it("rewrites path and query onto the forward origin and preserves the incoming request", () => {
		const incoming = new Request("https://sync-hub.black-pond-afbb.workers.dev/v1/sync/ops?x=1", {
			method: "POST",
			headers: {
				Authorization: "Bearer tok",
				"X-User-Id": "user-1",
				"X-Device-Id": "dev-1",
				Upgrade: "websocket",
			},
			body: '{"protocol_version":2,"ops":[]}',
		});
		const origin = resolveForwardOrigin("https://sync.cmem.ai/")!;
		const rewritten = rewriteForwardUrl(incoming, origin);
		expect(rewritten.origin).toBe("https://sync.cmem.ai");
		expect(rewritten.pathname).toBe("/v1/sync/ops");
		expect(rewritten.search).toBe("?x=1");

		const forwarded = buildForwardRequest(incoming, origin);
		expect(forwarded.method).toBe("POST");
		expect(forwarded.headers.get("Authorization")).toBe("Bearer tok");
		expect(forwarded.headers.get("X-User-Id")).toBe("user-1");
		expect(forwarded.headers.get("Upgrade")).toBe("websocket");
	});
});

describe("scheduled handler in forward mode", () => {
	it("returns without touching DO, KV, or the watchdog when FORWARD_ORIGIN is set", async () => {
		const { default: worker } = await import("../src/index");
		const logs: unknown[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => { logs.push(args); };
		try {
			const env = new Proxy({ FORWARD_ORIGIN: "https://sync.cmem.ai" } as Record<string, unknown>, {
				get(target, key) {
					if (key in target) return target[key as string];
					if (key === "then") return undefined;
					throw new Error(`forward-mode cron touched env.${String(key)}`);
				},
			});
			for (const cron of ["7 * * * *", "*/5 * * * *"]) {
				await worker.scheduled!(
					{ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
					env as unknown as Env,
					{} as ExecutionContext,
				);
			}
		} finally {
			console.log = originalLog;
		}
		expect(logs).toEqual([]);
	});
});
