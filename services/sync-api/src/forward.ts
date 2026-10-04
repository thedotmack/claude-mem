/**
 * Forward mode (Phase 12 step 5): `sync.cmem.ai` keeps answering every
 * shipped client, but each /v1/sync/* request is proxied verbatim to the
 * Supabase `cmem-sync` Edge Function. No Postgres, no auth here — the
 * upstream authenticates. Same idea as workers/sync-hub FORWARD_ORIGIN.
 *
 * - /health stays local (Fly check).
 * - /v1/sync/ws answers 410: the legacy socket is retired. Old clients treat
 *   a failed socket as advisory (jittered 1 s→60 s reconnect backoff) and the
 *   upstream's `X-Sync-Mode: poll` on HTTP responses switches reconnects off.
 * - /internal/v1/* answers 410: Pro reads Supabase directly after its merge.
 */
import { errorResponse, json } from "./auth";
import type { SyncApiEnv } from "./env";

const UPSTREAM_RETRY_AFTER_SECONDS = "5";

const FORWARDED_REQUEST_HEADERS = [
	"Authorization",
	"X-User-Id",
	"X-Device-Id",
	"X-Device-Name",
	"Content-Type",
	"Accept",
] as const;

/**
 * Not copied from the upstream response. Hop-by-hop headers are per
 * connection; Bun's fetch already decoded the body, so the upstream's
 * Content-Encoding / Content-Length no longer describe what we stream back.
 */
const DROPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"content-encoding",
	"content-length",
]);

export function buildForwardUrl(requestUrl: URL, forwardOrigin: string): string {
	return `${forwardOrigin}${requestUrl.pathname}${requestUrl.search}`;
}

function forwardedRequestHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	return headers;
}

function forwardedResponseHeaders(upstream: Response): Headers {
	const headers = new Headers();
	upstream.headers.forEach((value, name) => {
		if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
	});
	return headers;
}

function upstreamUnavailable(error: unknown): Response {
	console.error("sync-api forward: upstream request failed:", error);
	const response = json(503, { error: "sync_hub_unavailable", retryable: true });
	response.headers.set("Retry-After", UPSTREAM_RETRY_AFTER_SECONDS);
	return response;
}

async function forwardToUpstream(request: Request, url: URL, forwardOrigin: string): Promise<Response> {
	const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
	let upstream: Response;
	try {
		upstream = await fetch(buildForwardUrl(url, forwardOrigin), {
			method: request.method,
			headers: forwardedRequestHeaders(request),
			// Streamed, never buffered: large pushes pass straight through.
			body: hasBody ? request.body : undefined,
			// Required for a streamed request body (fetch spec).
			duplex: "half",
			redirect: "manual",
			// No overall deadline: a client disconnect aborts the upstream call,
			// and Fly's 255 s idle limit bounds a silent connection.
			signal: request.signal,
		});
	} catch (error) {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		return upstreamUnavailable(error);
	}
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: forwardedResponseHeaders(upstream),
	});
}

export function handleForwardRequest(request: Request, forwardOrigin: string): Promise<Response> | Response {
	const url = new URL(request.url);
	const { pathname } = url;

	if (pathname === "/health") {
		if (request.method !== "GET") return errorResponse(405, "use GET");
		return json(200, { ok: true, mode: "forward" });
	}
	if (pathname === "/v1/sync/ws") {
		const response = json(410, { error: "websocket_retired" });
		response.headers.set("X-Sync-Mode", "poll");
		return response;
	}
	if (pathname.startsWith("/internal/v1/")) {
		return json(410, { error: "internal_route_retired" });
	}
	if (!pathname.startsWith("/v1/sync/")) {
		return errorResponse(404, "not found");
	}
	return forwardToUpstream(request, url, forwardOrigin);
}

export interface ForwardProxyApp {
	env: SyncApiEnv;
	forwardOrigin: string;
	server: ReturnType<typeof Bun.serve>;
	url: string;
	stop: () => Promise<void>;
}

export function startForwardProxy(env: SyncApiEnv): ForwardProxyApp {
	const forwardOrigin = env.FORWARD_ORIGIN;
	if (forwardOrigin === null) {
		throw new Error("startForwardProxy requires FORWARD_ORIGIN");
	}
	const server = Bun.serve({
		hostname: env.HOST,
		port: env.PORT,
		// Bun's maximum; matches hub mode so slow upstream answers are not reset.
		idleTimeout: 255,
		fetch: (request) => handleForwardRequest(request, forwardOrigin),
	});
	const host = env.HOST === "0.0.0.0" ? "127.0.0.1" : env.HOST;
	const url = `http://${host}:${server.port}`;
	const stop = async (): Promise<void> => {
		server.stop(true);
	};
	return { env, forwardOrigin, server, url, stop };
}
