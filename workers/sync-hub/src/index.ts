/**
 * Sync Hub front Worker — stateless HTTP edge in front of the per-user
 * SyncHub Durable Object (Phase 1 of the two-lane sync plan).
 *
 * Responsibilities (and ONLY these — everything durable lives in the DO):
 *   - Parse the same headers the existing CloudSync client already sends
 *     (src/services/sync/CloudSync.ts:448-466): `Authorization: Bearer`,
 *     `X-User-Id`, `X-Device-Id`.
 *   - Token verification. This happens HERE, never in the DO (anti-pattern
 *     #3: no outbound I/O of any kind from the DO). Verdicts are checked
 *     against the cmem.ai verify endpoint (TOKEN_VERIFY_URL) and positive
 *     verdicts are cached in Workers KV (AUTH_CACHE) with a short TTL.
 *   - Route to `env.SYNC_HUB.getByName(userId)` and call RPC methods on the
 *     stub — non-WS data never flows through stub.fetch().
 *
 * Routes:
 *   POST /v1/sync/ops      — push a batch of ops
 *   GET  /v1/sync/changes  — cursor read (?since=<seq>&limit=<n≤500>)
 *   GET  /v1/sync/status   — hub status for this user
 *   GET  /v1/sync/ws       — advisory WebSocket upgrade (Phase 4): the ONE
 *                            path forwarded via stub.fetch(request). Same
 *                            authentication (canonical-userId binding) as
 *                            every other route; the socket itself carries
 *                            nothing durable — it is a downstream hint lane.
 */

import type { PushOp } from "./do/SyncHub";
import { INVALID_OPS_PREFIX, SyncHub } from "./do/SyncHub";

// The DO class must be exported from the Worker entrypoint.
export { SyncHub };

/** KV minimum expirationTtl is 60 seconds. */
const MIN_CACHE_TTL_SECONDS = 60;
const DEFAULT_CACHE_TTL_SECONDS = 300;

/**
 * Batch caps for POST /v1/sync/ops, sized against live Cloudflare docs
 * (fetched 2026-07-18):
 *
 *   - workers/runtime-apis/rpc: "The maximum serialized RPC limit is 32 MiB."
 *     (33,554,432 bytes, applies to serialized RPC calls — the DO stub call
 *     carrying the ops array included.)
 *   - durable-objects/platform/limits: "Maximum string, BLOB or table row
 *     size" is "2 MB", and the page pins the platform to decimal units
 *     ("1 GB = 1,000,000,000 bytes ... not a gibibyte"), so 2 MB means
 *     2,000,000 bytes. The per-op body backstop lives in the DO
 *     (MAX_BODY_BYTES = 1,990,000 there, reserving headroom for the row's
 *     sibling columns).
 *
 * Together: a request that passes these Worker-side caps can never explode
 * later at the RPC boundary (8 MB is >4x under 32 MiB, covering any
 * serialization overhead), and a per-op body that passes DO validation can
 * never hit the SQLite row limit. Oversize requests get a deliberate 413 —
 * never a generic 500 that clients would retry forever.
 */
const MAX_OPS_PER_PUSH = 500; // mirrors the getChanges page cap
const MAX_PUSH_BODY_BYTES = 8_000_000;

const encoder = new TextEncoder();

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(status: number, error: string): Response {
	return json(status, { error });
}

interface AuthOk {
	ok: true;
	userId: string;
	deviceId: string | null;
}

interface AuthFail {
	ok: false;
	response: Response;
}

/** SHA-256 the (userId, token) pair so raw tokens never appear as KV keys. */
async function verdictCacheKey(userId: string, token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`${userId}\n${token}`),
	);
	const bytes = Array.from(new Uint8Array(digest));
	return `verdict:${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Extract the canonical user id from a 2xx verify response body.
 * Accepts `{userId}` or `{user_id}`; returns null when absent/unparseable.
 */
async function canonicalUserId(res: Response): Promise<string | null> {
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	const id = record.userId ?? record.user_id;
	if (typeof id !== "string") return null;
	const trimmed = id.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function cacheTtlSeconds(env: Env): number {
	const parsed = Number.parseInt(env.AUTH_CACHE_TTL_SECONDS ?? "", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CACHE_TTL_SECONDS;
	return Math.max(MIN_CACHE_TTL_SECONDS, parsed);
}

/**
 * Authenticate the request. Fail-closed: a missing/invalid token is 401, a
 * token that does not belong to the claimed X-User-Id is 403, and an
 * unreachable verify endpoint is 503 (never silently allowed through).
 *
 * HARD CONTRACT for the verify endpoint (TOKEN_VERIFY_URL) — a deploy
 * prerequisite alongside the placeholder URL itself:
 *
 *   The endpoint MUST return, on a 2xx response, the canonical user id the
 *   token belongs to, as JSON `{userId}` or `{user_id}` (and/or answer
 *   401/403 when the token does not belong to the presented X-User-Id).
 *   This Worker compares that canonical id against the presented X-User-Id
 *   and refuses (403) on mismatch or when the id is missing. Without this
 *   binding, ANY valid subscriber token could act as ANY claimed user id —
 *   full read/write of another user's log — and a cached verdict would pin
 *   the forged pair. A verdict is therefore never cached unless it was
 *   bound to the canonical id.
 */
async function authenticate(request: Request, env: Env): Promise<AuthOk | AuthFail> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const userId = (request.headers.get("X-User-Id") ?? "").trim();
	// Trim device ids: "dev-a " and "dev-a" must be the same device — a stray
	// duplicate device would pin the compaction watermark at 0 forever.
	// Whitespace-only collapses to null (routes answer 400 for missing ids).
	const deviceIdTrimmed = (request.headers.get("X-Device-Id") ?? "").trim();
	const deviceId = deviceIdTrimmed.length > 0 ? deviceIdTrimmed : null;

	if (!authHeader.startsWith("Bearer ")) {
		return { ok: false, response: errorResponse(401, "missing bearer token") };
	}
	const token = authHeader.slice("Bearer ".length).trim();
	if (token.length === 0) {
		return { ok: false, response: errorResponse(401, "missing bearer token") };
	}
	if (userId.length === 0) {
		return { ok: false, response: errorResponse(401, "missing X-User-Id header") };
	}

	// Dev-only bypass for local `wrangler dev` / tests. Empty in production.
	if (env.DEV_ALLOW_ANY_TOKEN === "true") {
		return { ok: true, userId, deviceId };
	}

	const cacheKey = await verdictCacheKey(userId, token);
	const cached = await env.AUTH_CACHE.get(cacheKey);
	if (cached === "1") {
		return { ok: true, userId, deviceId };
	}

	let verifyRes: Response;
	try {
		verifyRes = await fetch(env.TOKEN_VERIFY_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-User-Id": userId,
			},
		});
	} catch {
		return { ok: false, response: errorResponse(503, "token verification unreachable") };
	}

	if (verifyRes.ok) {
		// Bind the token to the claimed user before trusting anything: a 2xx
		// alone only proves the token is valid for SOMEONE.
		const canonical = await canonicalUserId(verifyRes);
		if (canonical === null) {
			return {
				ok: false,
				response: errorResponse(403, "verify response missing canonical user id"),
			};
		}
		if (canonical !== userId) {
			return {
				ok: false,
				response: errorResponse(403, "token does not belong to the presented user id"),
			};
		}
		// Cache positive verdicts only, and only after the user binding above —
		// a newly-revoked token lingers at most TTL seconds; a newly-issued
		// token is never wrongly rejected; a forged pair is never pinned.
		await env.AUTH_CACHE.put(cacheKey, "1", { expirationTtl: cacheTtlSeconds(env) });
		return { ok: true, userId, deviceId };
	}
	if (verifyRes.status === 401 || verifyRes.status === 403) {
		return { ok: false, response: errorResponse(401, "invalid token") };
	}
	return {
		ok: false,
		response: errorResponse(503, `token verification failed (${verifyRes.status})`),
	};
}

async function handlePushOps(
	request: Request,
	env: Env,
	userId: string,
	deviceId: string,
): Promise<Response> {
	const raw = await request.text();
	// Deliberate 413s (see the cap constants above): an oversize batch must
	// fail loudly and permanently here, not as a retriable-looking 500 at the
	// RPC boundary or inside the DO.
	if (encoder.encode(raw).length > MAX_PUSH_BODY_BYTES) {
		return errorResponse(
			413,
			`request body exceeds ${MAX_PUSH_BODY_BYTES} bytes — split the batch`,
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return errorResponse(400, "request body is not valid JSON");
	}
	const ops = (body as { ops?: unknown } | null)?.ops;
	if (!Array.isArray(ops)) {
		return errorResponse(400, "request body must be {ops: [...]}");
	}
	if (ops.length > MAX_OPS_PER_PUSH) {
		return errorResponse(
			413,
			`too many ops in one request (${ops.length} > ${MAX_OPS_PER_PUSH}) — split the batch`,
		);
	}

	const stub = env.SYNC_HUB.getByName(userId);
	try {
		const result = await stub.pushOps(deviceId, ops as PushOp[]);
		if ("refused" in result) {
			return errorResponse(400, result.error);
		}
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleGetChanges(
	url: URL,
	env: Env,
	userId: string,
	deviceId: string,
): Promise<Response> {
	const sinceRaw = url.searchParams.get("since") ?? "0";
	const limitRaw = url.searchParams.get("limit");
	const since = Number(sinceRaw);
	if (!Number.isFinite(since) || since < 0) {
		return errorResponse(400, "since must be a non-negative number");
	}
	let limit = 500;
	if (limitRaw !== null) {
		limit = Number(limitRaw);
		if (!Number.isFinite(limit) || limit < 1) {
			return errorResponse(400, "limit must be a positive number");
		}
	}

	const stub = env.SYNC_HUB.getByName(userId);
	try {
		const result = await stub.getChanges(deviceId, since, limit);
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleGetStatus(env: Env, userId: string): Promise<Response> {
	const stub = env.SYNC_HUB.getByName(userId);
	try {
		const result = await stub.getStatus();
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

function mapHubError(e: unknown): Response {
	if (e instanceof Error && e.message.includes(INVALID_OPS_PREFIX)) {
		return errorResponse(400, e.message);
	}
	console.error("sync-hub error:", e);
	return errorResponse(500, "internal error");
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		if (
			pathname !== "/v1/sync/ops" &&
			pathname !== "/v1/sync/changes" &&
			pathname !== "/v1/sync/status" &&
			pathname !== "/v1/sync/ws"
		) {
			return errorResponse(404, "not found");
		}

		const auth = await authenticate(request, env);
		if (!auth.ok) return auth.response;

		if (pathname === "/v1/sync/ws") {
			// Advisory WebSocket upgrade (plan Phase 4 task 1) — the ONE path
			// that reaches the DO via stub.fetch(). Shape copied from the
			// hibernation example (Phase 0.1 WS row): Upgrade-header check in
			// front, 426 otherwise; the DO re-checks and performs the accept.
			if (request.method !== "GET") return errorResponse(405, "use GET");
			if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
			const upgradeHeader = request.headers.get("Upgrade");
			if (!upgradeHeader || upgradeHeader !== "websocket") {
				return errorResponse(426, "expected Upgrade: websocket");
			}
			const stub = env.SYNC_HUB.getByName(auth.userId);
			return stub.fetch(request);
		}

		if (pathname === "/v1/sync/ops") {
			if (request.method !== "POST") return errorResponse(405, "use POST");
			if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
			return handlePushOps(request, env, auth.userId, auth.deviceId);
		}

		if (pathname === "/v1/sync/changes") {
			if (request.method !== "GET") return errorResponse(405, "use GET");
			if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
			return handleGetChanges(url, env, auth.userId, auth.deviceId);
		}

		// /v1/sync/status
		if (request.method !== "GET") return errorResponse(405, "use GET");
		return handleGetStatus(env, auth.userId);
	},
} satisfies ExportedHandler<Env>;
