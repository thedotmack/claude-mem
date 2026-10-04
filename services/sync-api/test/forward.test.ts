import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { loadEnv, parseForwardOrigin } from "../src/env";
import { startForwardProxy, type ForwardProxyApp } from "../src/forward";
import { startSyncApi } from "../src/index";

interface CapturedUpstreamRequest {
	method: string;
	pathname: string;
	search: string;
	headers: Headers;
	bodyByteLength: number;
	bodySha256: string;
	receivedChunkedOrStreamed: boolean;
}

const FUNCTION_PATH_PREFIX = "/functions/v1/cmem-sync";

let upstream: ReturnType<typeof Bun.serve>;
let capturedUpstreamRequests: CapturedUpstreamRequest[] = [];
let proxy: ForwardProxyApp;

function startProxy(forwardOrigin: string): ForwardProxyApp {
	return startForwardProxy(loadEnv({ FORWARD_ORIGIN: forwardOrigin, PORT: "0", HOST: "127.0.0.1" }));
}

beforeAll(() => {
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const bytes = new Uint8Array(await request.arrayBuffer());
			capturedUpstreamRequests.push({
				method: request.method,
				pathname: url.pathname,
				search: url.search,
				headers: request.headers,
				bodyByteLength: bytes.byteLength,
				bodySha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				receivedChunkedOrStreamed: request.headers.get("transfer-encoding") === "chunked",
			});
			if (url.pathname.endsWith("/v1/sync/status")) {
				return new Response(JSON.stringify({ ok: true, path: url.pathname }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"X-Sync-Mode": "poll",
						"Cache-Control": "no-store",
						"X-Upstream-Marker": "kept",
						Connection: "keep-alive",
					},
				});
			}
			if (url.pathname.endsWith("/v1/sync/ops")) {
				return new Response(JSON.stringify({ error: "sync_hub_busy", retryable: true }), {
					status: 503,
					headers: { "Content-Type": "application/json", "Retry-After": "7", "X-Sync-Mode": "poll" },
				});
			}
			if (url.pathname.endsWith("/v1/sync/stream-back")) {
				return new Response("x".repeat(3_000_000), { headers: { "Content-Type": "text/plain" } });
			}
			return new Response("unexpected", { status: 418 });
		},
	});
	proxy = startProxy(`http://127.0.0.1:${upstream.port}${FUNCTION_PATH_PREFIX}/`);
});

afterAll(async () => {
	await proxy.stop();
	upstream.stop(true);
});

describe("forward mode: env validation", () => {
	it("does not require DATABASE_URL when FORWARD_ORIGIN is set", () => {
		const env = loadEnv({ FORWARD_ORIGIN: "https://example.supabase.co/functions/v1/cmem-sync/" });
		expect(env.FORWARD_ORIGIN).toBe("https://example.supabase.co/functions/v1/cmem-sync");
		expect(env.DATABASE_URL).toBe("");
	});

	it("still requires DATABASE_URL in hub mode", () => {
		expect(() => loadEnv({})).toThrow(/DATABASE_URL is required/);
		expect(loadEnv({ DATABASE_URL: "postgres://x" }).FORWARD_ORIGIN).toBeNull();
		expect(loadEnv({ DATABASE_URL: "postgres://x", FORWARD_ORIGIN: "  " }).FORWARD_ORIGIN).toBeNull();
	});

	it("rejects non-https, query, fragment, credentials and garbage", () => {
		expect(() => parseForwardOrigin("http://example.com/fn")).toThrow(/https/);
		expect(() => parseForwardOrigin("ftp://example.com")).toThrow(/https/);
		expect(() => parseForwardOrigin("https://example.com/fn?x=1")).toThrow(/query/);
		expect(() => parseForwardOrigin("https://example.com/fn?")).toThrow(/query/);
		expect(() => parseForwardOrigin("https://example.com/fn#frag")).toThrow(/fragment/);
		expect(() => parseForwardOrigin("https://u:p@example.com/fn")).toThrow(/credentials/);
		expect(() => parseForwardOrigin("not a url")).toThrow(/not a valid URL/);
	});

	it("allows http:// only for loopback hosts", () => {
		expect(parseForwardOrigin("http://127.0.0.1:54321/functions/v1/cmem-sync"))
			.toBe("http://127.0.0.1:54321/functions/v1/cmem-sync");
		expect(parseForwardOrigin("http://localhost:54321")).toBe("http://localhost:54321");
		expect(() => parseForwardOrigin("http://10.0.0.5:54321")).toThrow(/https/);
	});

	it("startSyncApi refuses to open Postgres in forward mode", async () => {
		const env = loadEnv({ FORWARD_ORIGIN: "https://example.com/fn" });
		await expect(startSyncApi(env)).rejects.toThrow(/FORWARD_ORIGIN is set/);
	});
});

describe("forward mode: proxy", () => {
	it("serves /health locally with mode forward", async () => {
		const before = capturedUpstreamRequests.length;
		const res = await fetch(`${proxy.url}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, mode: "forward" });
		expect(capturedUpstreamRequests.length).toBe(before);
	});

	it("forwards method, path, query and the allowed headers; returns status, body and headers", async () => {
		capturedUpstreamRequests = [];
		const res = await fetch(`${proxy.url}/v1/sync/status?since=12&limit=3`, {
			headers: {
				Authorization: "Bearer cm_pro_token",
				"X-User-Id": "user-1",
				"X-Device-Id": "device-1",
				"X-Device-Name": "laptop",
				Accept: "application/json",
				Cookie: "must-not-forward=1",
				"X-Random-Header": "must-not-forward",
			},
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, path: `${FUNCTION_PATH_PREFIX}/v1/sync/status` });
		expect(res.headers.get("X-Sync-Mode")).toBe("poll");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("X-Upstream-Marker")).toBe("kept");
		expect(res.headers.get("Content-Type")).toBe("application/json");

		expect(capturedUpstreamRequests).toHaveLength(1);
		const seen = capturedUpstreamRequests[0];
		expect(seen.method).toBe("GET");
		expect(seen.pathname).toBe(`${FUNCTION_PATH_PREFIX}/v1/sync/status`);
		expect(seen.search).toBe("?since=12&limit=3");
		expect(seen.headers.get("Authorization")).toBe("Bearer cm_pro_token");
		expect(seen.headers.get("X-User-Id")).toBe("user-1");
		expect(seen.headers.get("X-Device-Id")).toBe("device-1");
		expect(seen.headers.get("X-Device-Name")).toBe("laptop");
		expect(seen.headers.get("Accept")).toBe("application/json");
		expect(seen.headers.get("Cookie")).toBeNull();
		expect(seen.headers.get("X-Random-Header")).toBeNull();
	});

	it("streams a large push body through unchanged and passes upstream errors + Retry-After back", async () => {
		capturedUpstreamRequests = [];
		const chunkBytes = new TextEncoder().encode("a".repeat(1_000_000));
		const chunkCount = 6;
		const hasher = new Bun.CryptoHasher("sha256");
		for (let i = 0; i < chunkCount; i++) hasher.update(chunkBytes);
		const expectedSha = hasher.digest("hex");
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent === chunkCount) { controller.close(); return; }
				sent++;
				controller.enqueue(chunkBytes);
			},
		});
		const res = await fetch(`${proxy.url}/v1/sync/ops`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer t", "X-Device-Id": "d" },
			body,
			duplex: "half",
		});
		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("7");
		expect(res.headers.get("X-Sync-Mode")).toBe("poll");
		expect(await res.json()).toEqual({ error: "sync_hub_busy", retryable: true });

		expect(capturedUpstreamRequests).toHaveLength(1);
		const seen = capturedUpstreamRequests[0];
		expect(seen.method).toBe("POST");
		expect(seen.headers.get("Content-Type")).toBe("application/json");
		expect(seen.bodyByteLength).toBe(chunkBytes.byteLength * chunkCount);
		expect(seen.bodySha256).toBe(expectedSha);
		// The proxy re-streams the body (chunked) rather than buffering it to a Content-Length.
		expect(seen.receivedChunkedOrStreamed).toBe(true);
	});

	it("streams a large response body back", async () => {
		const res = await fetch(`${proxy.url}/v1/sync/stream-back`);
		expect(res.status).toBe(200);
		expect((await res.text()).length).toBe(3_000_000);
	});

	it("answers the legacy WebSocket route with 410 websocket_retired", async () => {
		const before = capturedUpstreamRequests.length;
		const res = await fetch(`${proxy.url}/v1/sync/ws`, {
			headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: "Bearer t" },
		});
		expect(res.status).toBe(410);
		expect(await res.json()).toEqual({ error: "websocket_retired" });
		expect(capturedUpstreamRequests.length).toBe(before);
	});

	it("fails a real WebSocket handshake (old clients' advisory socket closes and backs off)", async () => {
		const ws = new WebSocket(`${proxy.url.replace("http:", "ws:")}/v1/sync/ws`);
		const closed = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(false);
			ws.onclose = () => resolve(true);
		});
		expect(closed).toBe(true);
	});

	it("answers /internal/v1/* with 410", async () => {
		for (const path of ["/internal/v1/sync/metadata", "/internal/v1/projection/drain", "/internal/v1/sync/reset"]) {
			const res = await fetch(`${proxy.url}${path}`, { method: "POST", body: "{}" });
			expect(res.status).toBe(410);
			expect(await res.json()).toEqual({ error: "internal_route_retired" });
		}
	});

	it("404s anything outside /v1/sync/*", async () => {
		const res = await fetch(`${proxy.url}/v2/anything`);
		expect(res.status).toBe(404);
	});

	it("returns 503 sync_hub_unavailable + Retry-After: 5 when the upstream is unreachable", async () => {
		const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const deadPort = dead.port;
		dead.stop(true);
		const orphanProxy = startProxy(`http://127.0.0.1:${deadPort}${FUNCTION_PATH_PREFIX}`);
		try {
			const res = await fetch(`${orphanProxy.url}/v1/sync/status`, { headers: { Authorization: "Bearer t" } });
			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("5");
			expect(await res.json()).toEqual({ error: "sync_hub_unavailable", retryable: true });
		} finally {
			await orphanProxy.stop();
		}
	});
});
