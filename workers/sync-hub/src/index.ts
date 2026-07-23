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
 *   POST /internal/v1/sync/metadata    — payload-free Hub state for Pro.
 *   POST /internal/v1/sync/device-name — rename an existing Hub device.
 *   POST /internal/v1/sync/reset       — wipe one user's Hub to pristine
 *                                        state (pre-launch hygiene; DEPLOY.md
 *                                        §1.6). Secret-gated like the other
 *                                        internal routes; kill-switch KV is
 *                                        deliberately untouched.
 */

import { CONTROL_PLANE_PROBE_CRON, runControlPlaneProbe } from "./control-plane-probe";
import type { PushOp } from "./do/SyncHub";
import {
	DEVICE_LIMIT_ERROR,
	INVALID_OPS_PREFIX,
	PROJECTION_LEASE_MS,
	PROJECTION_ERROR_PREFIX,
	SyncHub,
} from "./do/SyncHub";
import { readKillSwitch, SYNC_MODE_HEADER, SYNC_MODE_POLL } from "./kill-switch";
import {
	PROJECTION_FETCH_TIMEOUT_MS,
	PROJECTION_PAGE_MAX_BYTES,
	PROJECTION_PAGE_MAX_OPS,
	PROJECTION_PROTOCOL_VERSION,
	serializeProjectionRequest,
} from "./projection-protocol";
import { runWatchdog } from "./watchdog";

// The DO class must be exported from the Worker entrypoint.
export { SyncHub };

/** KV minimum expirationTtl and the public token-rotation bound are both 60s. */
const MIN_CACHE_TTL_SECONDS = 60;
const MAX_CACHE_TTL_SECONDS = 60;
const DEFAULT_CACHE_TTL_SECONDS = 60;

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
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/**
 * Pro declares a 60-second maximum duration. Abort the complete response-body
 * read at 45 seconds while the Hub holds a 90-second fencing lease:
 * Hub abort (45s) < Pro platform ceiling (60s) < Hub lease (90s).
 */
if (PROJECTION_FETCH_TIMEOUT_MS >= PROJECTION_LEASE_MS) {
	throw new Error("projection fetch timeout must be strictly shorter than the Hub lease");
}

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
	deviceName: string | null;
}

interface AuthFail {
	ok: false;
	response: Response;
}

/** Narrow I/O seam for auth failure-path tests; production uses closed defaults. */
export interface AuthDependencies {
	readCachedVerdict(cacheKey: string): Promise<string | null>;
	cacheVerifiedVerdict(cacheKey: string, ttlSeconds: number): Promise<void>;
	verifyToken(request: Request): Promise<Response>;
	logCacheFailure(operation: "get" | "put", error: unknown): void;
}

function defaultAuthDependencies(env: Env): AuthDependencies {
	return {
		readCachedVerdict: (cacheKey) => env.AUTH_CACHE.get(cacheKey),
		cacheVerifiedVerdict: (cacheKey, ttlSeconds) =>
			env.AUTH_CACHE.put(cacheKey, "1", { expirationTtl: ttlSeconds }),
		verifyToken: (request) => fetch(request),
		logCacheFailure(operation, error) {
			// Never log the cache key: it is derived from a bearer credential.
			console.warn("sync-hub auth cache unavailable:", {
				operation,
				errorName: error instanceof Error ? error.name : "unknown",
			});
		},
	};
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
	const parsed = parseBoundedPositiveInteger(env.AUTH_CACHE_TTL_SECONDS ?? "", MAX_CACHE_TTL_SECONDS);
	if (parsed === null) return DEFAULT_CACHE_TTL_SECONDS;
	return Math.min(
		MAX_CACHE_TTL_SECONDS,
		Math.max(MIN_CACHE_TTL_SECONDS, parsed),
	);
}

/** Parse only deliberately small control-plane integers, never uint64 data. */
function parseBoundedPositiveInteger(raw: string, maximum: number): number | null {
	if (!/^[1-9][0-9]*$/.test(raw)) return null;
	let value = 0;
	for (const digit of raw) {
		value = (value * 10) + (digit.charCodeAt(0) - 48);
		if (value > maximum) return maximum;
	}
	return value;
}

/**
 * Authenticate the request. Fail-closed: a missing/invalid token is 401, a
 * token that does not belong to the claimed X-User-Id is 403, and an
 * unreachable verify endpoint is 503 (never silently allowed through).
 *
 * HARD CONTRACT for the implemented verify endpoint (TOKEN_VERIFY_URL), which
 * must be deployed and canaried before this Worker is activated:
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
export async function authenticateRequest(
	request: Request,
	env: Env,
	dependencies: AuthDependencies = defaultAuthDependencies(env),
): Promise<AuthOk | AuthFail> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const userId = (request.headers.get("X-User-Id") ?? "").trim();
	// Trim transport identity: "dev-a " and "dev-a" must address the same
	// logical device. Whitespace-only collapses to null (routes answer 400 for
	// missing ids). Canonical operation bodies themselves are never rewritten.
	const deviceIdTrimmed = (request.headers.get("X-Device-Id") ?? "").trim();
	const deviceId = deviceIdTrimmed.length > 0 ? deviceIdTrimmed : null;
	const deviceNameTrimmed = (request.headers.get("X-Device-Name") ?? "").trim();
	if (deviceId !== null && deviceId.length > 128) {
		return { ok: false, response: errorResponse(400, "X-Device-Id must be at most 128 characters") };
	}
	if (deviceNameTrimmed.length > 80) {
		return { ok: false, response: errorResponse(400, "X-Device-Name must be at most 80 characters") };
	}
	const deviceName = deviceNameTrimmed.length > 0 ? deviceNameTrimmed : null;

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

	const cacheKey = await verdictCacheKey(userId, token);
	let cached: string | null = null;
	try {
		cached = await dependencies.readCachedVerdict(cacheKey);
	} catch (error) {
		// KV is an optimization, not an authentication authority. A read outage
		// becomes a cache miss and still requires the upstream verifier to pass.
		dependencies.logCacheFailure("get", error);
	}
	if (cached === "1") {
		return { ok: true, userId, deviceId, deviceName };
	}

	let verifyRes: Response;
	try {
		verifyRes = await dependencies.verifyToken(
			new Request(env.TOKEN_VERIFY_URL, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
					"X-User-Id": userId,
				},
			}),
		);
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
		// a newly-revoked token lingers at most 60 seconds; a newly-issued
		// token is never wrongly rejected; a forged pair is never pinned.
		try {
			await dependencies.cacheVerifiedVerdict(cacheKey, cacheTtlSeconds(env));
		} catch (error) {
			// A verified request must not fail because the positive-verdict cache
			// could not be populated. The next request will verify upstream again.
			dependencies.logCacheFailure("put", error);
		}
		return { ok: true, userId, deviceId, deviceName };
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
	deviceName: string | null,
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
	if ((body as { protocol_version?: unknown } | null)?.protocol_version !== 2) {
		return errorResponse(400, "request body requires protocol_version: 2");
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
		const result = await stub.pushOps(deviceId, ops as PushOp[], deviceName);
		if ("refused" in result) {
			return errorResponse(result.error === DEVICE_LIMIT_ERROR ? 409 : 400, result.error);
		}
		const projection = await drainProjection(env, userId, result.head_seq);
		if (!projection.ok) {
			return json(projection.httpStatus, {
				error: projection.error,
				durable: true,
				retryable: projection.retryable,
				head_seq: result.head_seq,
				projected_seq: projection.projectedSeq,
			});
		}
		return json(200, { ...result, projected_seq: projection.projectedSeq });
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleGetChanges(
	url: URL,
	env: Env,
	userId: string,
	deviceId: string,
	deviceName: string | null,
): Promise<Response> {
	const sinceRaw = url.searchParams.get("since") ?? "0";
	const limitRaw = url.searchParams.get("limit");
	if (!CANONICAL_DECIMAL.test(sinceRaw)) {
		return errorResponse(400, "since must be a canonical unsigned decimal string");
	}
	let limit = 500;
	if (limitRaw !== null) {
		const parsedLimit = parseBoundedPositiveInteger(limitRaw, 500);
		if (parsedLimit === null) {
			return errorResponse(400, "limit must be a positive number");
		}
		limit = parsedLimit;
	}

	const stub = env.SYNC_HUB.getByName(userId);
	try {
		const result = await stub.getChanges(deviceId, sinceRaw, limit, deviceName);
		if ("refused" in result) return errorResponse(409, result.error);
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleGetStatus(
	env: Env,
	userId: string,
	deviceId: string | null,
	deviceName: string | null,
): Promise<Response> {
	const stub = env.SYNC_HUB.getByName(userId);
	try {
		const result = await stub.getStatus(deviceId, deviceName);
		if ("refused" in result) return errorResponse(409, result.error);
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

function hasInternalCredential(request: Request, env: Env): boolean {
	const secret = env.CMEM_INTERNAL_PROJECTOR_SECRET ?? "";
	return secret.length > 0 && request.headers.get("Authorization") === `Bearer ${secret}`;
}

function exactKeys(record: Record<string, unknown>, expected: string[]): boolean {
	const keys = Object.keys(record).sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

async function readInternalBody(request: Request): Promise<Record<string, unknown> | null> {
	let value: unknown;
	try { value = await request.json(); } catch { return null; }
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

async function handleMetadataRead(request: Request, env: Env): Promise<Response> {
	if (!hasInternalCredential(request, env)) return errorResponse(401, "invalid internal credential");
	const body = await readInternalBody(request);
	if (
		body === null
		|| !exactKeys(body, ["protocol_version", "user_id"])
		|| body.protocol_version !== 1
		|| typeof body.user_id !== "string"
		|| body.user_id.trim().length === 0
	) {
		return errorResponse(400, "expected exactly {protocol_version:1,user_id}");
	}
	const userId = body.user_id.trim();
	try {
		return json(200, await env.SYNC_HUB.getByName(userId).getMetadata(userId));
	} catch (error) {
		return mapHubError(error);
	}
}

/**
 * Secret-gated per-user reset (auth + body contract mirror the internal
 * metadata route exactly). The DO wipes its storage and reinitializes a
 * pristine hub; the kill switch is KV state owned by this Worker and is
 * deliberately NOT touched by a reset.
 */
async function handleHubReset(request: Request, env: Env): Promise<Response> {
	if (!hasInternalCredential(request, env)) return errorResponse(401, "invalid internal credential");
	const body = await readInternalBody(request);
	if (
		body === null
		|| !exactKeys(body, ["protocol_version", "user_id"])
		|| body.protocol_version !== 1
		|| typeof body.user_id !== "string"
		|| body.user_id.trim().length === 0
	) {
		return errorResponse(400, "expected exactly {protocol_version:1,user_id}");
	}
	const userId = body.user_id.trim();
	try {
		return json(200, await env.SYNC_HUB.getByName(userId).resetAllState());
	} catch (error) {
		return mapHubError(error);
	}
}

async function handleDeviceRename(request: Request, env: Env): Promise<Response> {
	if (!hasInternalCredential(request, env)) return errorResponse(401, "invalid internal credential");
	const body = await readInternalBody(request);
	if (
		body === null
		|| !exactKeys(body, ["device_id", "name", "protocol_version", "user_id"])
		|| body.protocol_version !== 1
		|| typeof body.user_id !== "string"
		|| typeof body.device_id !== "string"
		|| typeof body.name !== "string"
	) {
		return errorResponse(400, "expected exactly {protocol_version:1,user_id,device_id,name}");
	}
	const userId = body.user_id.trim();
	const deviceId = body.device_id.trim();
	const name = body.name.trim();
	if (userId.length === 0) return errorResponse(400, "user_id must be non-empty");
	if (deviceId.length === 0 || deviceId.length > 128) return errorResponse(400, "device_id must be 1-128 characters");
	if (name.length === 0 || name.length > 80) return errorResponse(400, "name must be 1-80 characters");
	try {
		const renamed = await env.SYNC_HUB.getByName(userId).renameDevice(deviceId, name);
		if (!renamed) return errorResponse(404, "device not found");
		return json(200, { protocol_version: 1, user_id: userId, device_id: deviceId, name });
	} catch (error) {
		return mapHubError(error);
	}
}

function mapHubError(e: unknown): Response {
	if (e instanceof Error && e.message.includes(DEVICE_LIMIT_ERROR)) {
		return errorResponse(409, DEVICE_LIMIT_ERROR);
	}
	if (e instanceof Error && e.message.includes(INVALID_OPS_PREFIX)) {
		return errorResponse(400, e.message);
	}
	if (e instanceof Error && e.message.includes(PROJECTION_ERROR_PREFIX)) {
		return errorResponse(503, e.message);
	}
	console.error("sync-hub error:", e);
	return errorResponse(500, "internal error");
}

interface DrainSuccess {
	ok: true;
	projectedSeq: string;
}

interface DrainFailure {
	ok: false;
	error: string;
	projectedSeq: string;
	httpStatus: 409 | 503;
	retryable: boolean;
}

type DrainResult = DrainSuccess | DrainFailure;

export interface ProjectionFetchResult {
	ok: boolean;
	status: number;
	bodyText: string;
}

export type ProjectionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Bound both the upstream fetch and consumption of its response body. A fetch
 * that returns headers but stalls the body must not outlive the fencing lease.
 */
export async function fetchProjectionWithTimeout(
	url: string,
	requestBody: string,
	secret: string,
	timeoutMs = PROJECTION_FETCH_TIMEOUT_MS,
	fetchImpl: ProjectionFetch = fetch,
): Promise<ProjectionFetchResult> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= PROJECTION_LEASE_MS) {
		throw new Error("projection timeout must be a positive safe integer strictly shorter than the Hub lease");
	}
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort("projection fetch deadline exceeded");
			reject(new Error("projection_upstream_timeout"));
		}, timeoutMs);
	});
	const request = (async (): Promise<ProjectionFetchResult> => {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${secret}`,
			},
			body: requestBody,
			signal: controller.signal,
		});
		const bodyText = await response.text();
		return { ok: response.ok, status: response.status, bodyText };
	})();
	try {
		// Do not depend on the fetch implementation honoring AbortSignal. The
		// losing request may still complete upstream, which is why drainProjection
		// retains its fencing lease after this deadline rejects.
		return await Promise.race([request, deadline]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export interface ProjectionDrainDependencies {
	/** Test seam only; production always uses the 45-second constant. */
	fetchTimeoutMs?: number;
	/** Test seam for network-failure classification; production uses global fetch. */
	fetchImpl?: ProjectionFetch;
	/** Test seam for deterministic Durable Object lease timestamps. */
	now?: () => number;
}

function projectionNow(dependencies: ProjectionDrainDependencies): number | undefined {
	return dependencies.now?.();
}

/**
 * Drain one user's authoritative Hub checkpoint through targetSeq. The DO
 * only leases/pages/CAS-advances; all outbound I/O remains in this Worker.
 */
export async function drainProjection(
	env: Env,
	userId: string,
	targetSeq: string,
	dependencies: ProjectionDrainDependencies = {},
): Promise<DrainResult> {
	const stub = env.SYNC_HUB.getByName(userId);
	let state = await stub.getProjectionState();
	if (decimalAtLeast(state.projected_seq, targetSeq)) {
		return { ok: true, projectedSeq: state.projected_seq };
	}
	if (!env.INTERNAL_PROJECTOR_URL || !env.CMEM_INTERNAL_PROJECTOR_SECRET) {
		return {
			ok: false,
			error: "projection_not_configured",
			projectedSeq: state.projected_seq,
			httpStatus: 503,
			retryable: true,
		};
	}
	const acquiredAt = projectionNow(dependencies);
	const lease = acquiredAt === undefined
		? await stub.acquireProjectionLease(targetSeq)
		: await stub.acquireProjectionLease(targetSeq, acquiredAt);
	if (!lease.acquired || !lease.lease_token) {
		state = await stub.getProjectionState();
		if (decimalAtLeast(state.projected_seq, targetSeq)) {
			return { ok: true, projectedSeq: state.projected_seq };
		}
		return {
			ok: false,
			error: "projection_busy",
			projectedSeq: state.projected_seq,
			httpStatus: 503,
			retryable: true,
		};
	}

	const token = lease.lease_token;
	let releaseLeaseEarly = false;
	try {
		for (;;) {
			state = await stub.getProjectionState();
			if (decimalAtLeast(state.projected_seq, targetSeq)) {
				// A predecessor may have checkpointed and released between our
				// initial state read and lease acquisition. The authoritative Hub
				// checkpoint proves it finished, so this otherwise redundant lease
				// is safe to release immediately.
				releaseLeaseEarly = true;
				return { ok: true, projectedSeq: state.projected_seq };
			}
			const pageAt = projectionNow(dependencies);
			const page = pageAt === undefined
				? await stub.getProjectionPage(
					token,
					targetSeq,
					userId,
					PROJECTION_PAGE_MAX_OPS,
					PROJECTION_PAGE_MAX_BYTES,
				)
				: await stub.getProjectionPage(
					token,
					targetSeq,
					userId,
					PROJECTION_PAGE_MAX_OPS,
					PROJECTION_PAGE_MAX_BYTES,
					pageAt,
				);
			if (page.ops.length === 0) {
				return {
					ok: false,
					error: "projection_page_empty",
					projectedSeq: state.projected_seq,
					httpStatus: 503,
					retryable: true,
				};
			}
			const requestBody = serializeProjectionRequest({
				userId,
				epoch: page.epoch,
				fromSeqExclusive: page.from_seq_exclusive,
				throughSeq: page.through_seq,
				ops: page.ops,
			});
			if (encoder.encode(requestBody).length > PROJECTION_PAGE_MAX_BYTES) {
				return {
					ok: false,
					error: "projection_page_too_large",
					projectedSeq: state.projected_seq,
					httpStatus: 503,
					retryable: true,
				};
			}
			// Renew immediately before the bounded outbound request. The token is
			// then checked again by advanceProjectionCheckpoint's fenced CAS.
			const heartbeatAt = projectionNow(dependencies);
			if (heartbeatAt === undefined) await stub.heartbeatProjectionLease(token);
			else await stub.heartbeatProjectionLease(token, heartbeatAt);
			// From this point until a deterministic response/checkpoint outcome,
			// the upstream may still be applying the request even if our fetch
			// rejects. Never let a successor overlap that ambiguous predecessor.
			releaseLeaseEarly = false;
			let response: ProjectionFetchResult;
			try {
				response = await fetchProjectionWithTimeout(
					env.INTERNAL_PROJECTOR_URL,
					requestBody,
					env.CMEM_INTERNAL_PROJECTOR_SECRET,
					dependencies.fetchTimeoutMs,
					dependencies.fetchImpl,
				);
			} catch (error) {
				if (error instanceof Error && error.message === "projection_upstream_timeout") {
					return {
						ok: false,
						error: error.message,
						projectedSeq: state.projected_seq,
						httpStatus: 503,
						retryable: true,
					};
				}
				return {
					ok: false,
					error: "projection_upstream_unreachable",
					projectedSeq: state.projected_seq,
					httpStatus: 503,
					retryable: true,
				};
			}
			if (!response.ok) {
				if (response.status === 409) {
					// Pro's deterministic rejection is a complete, nonretryable
					// outcome. No request remains capable of mutating the projection.
					releaseLeaseEarly = true;
					return {
						ok: false,
						error: "projection_upstream_409",
						projectedSeq: state.projected_seq,
						httpStatus: 409,
						retryable: false,
					};
				}
				return {
					ok: false,
					error: `projection_upstream_${response.status}`,
					projectedSeq: state.projected_seq,
					httpStatus: 503,
					retryable: true,
				};
			}
			let projected: unknown;
			try { projected = JSON.parse(response.bodyText); } catch {
				return {
					ok: false,
					error: "projection_response_not_json",
					projectedSeq: state.projected_seq,
					httpStatus: 503,
					retryable: true,
				};
			}
			const result = projected as Record<string, unknown>;
			if (
				result.protocol_version !== PROJECTION_PROTOCOL_VERSION
				|| result.epoch !== page.epoch
				|| result.projected_through_seq !== page.through_seq
			) {
				return {
					ok: false,
					error: "projection_response_mismatch",
					projectedSeq: state.projected_seq,
					httpStatus: 503,
					retryable: true,
				};
			}
			const checkpointAt = projectionNow(dependencies);
			state = checkpointAt === undefined
				? await stub.advanceProjectionCheckpoint(
					token,
					page.epoch,
					page.from_seq_exclusive,
					page.through_seq,
				)
				: await stub.advanceProjectionCheckpoint(
					token,
					page.epoch,
					page.from_seq_exclusive,
					page.through_seq,
					checkpointAt,
				);
			releaseLeaseEarly = true;
		}
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "projection_failed",
			projectedSeq: (await stub.getProjectionState()).projected_seq,
			httpStatus: 503,
			retryable: true,
		};
	} finally {
		if (releaseLeaseEarly) await stub.releaseProjectionLease(token);
	}
}

function decimalAtLeast(left: string, right: string): boolean {
	if (!CANONICAL_DECIMAL.test(left) || !CANONICAL_DECIMAL.test(right)) return false;
	if (left.length !== right.length) return left.length > right.length;
	return left >= right;
}

async function handleRepairDrain(request: Request, env: Env): Promise<Response> {
	const expected = `Bearer ${env.CMEM_INTERNAL_PROJECTOR_SECRET ?? ""}`;
	if (!env.CMEM_INTERNAL_PROJECTOR_SECRET || request.headers.get("Authorization") !== expected) {
		return errorResponse(401, "invalid internal projector credential");
	}
	let body: unknown;
	try { body = await request.json(); } catch { return errorResponse(400, "request body is not JSON"); }
	const record = body as Record<string, unknown> | null;
	if (record?.protocol_version !== 1 || typeof record.user_id !== "string" || record.user_id.length === 0) {
		return errorResponse(400, "expected {protocol_version:1,user_id,through_seq?}");
	}
	const stub = env.SYNC_HUB.getByName(record.user_id);
	const state = await stub.getProjectionState();
	const target = record.through_seq === undefined ? state.head_seq : record.through_seq;
	if (typeof target !== "string" || !CANONICAL_DECIMAL.test(target)) {
		return errorResponse(400, "through_seq must be a canonical unsigned decimal string");
	}
	if (decimalAtLeast(target, state.head_seq) && target !== state.head_seq) {
		return errorResponse(400, "through_seq exceeds Hub head_seq");
	}
	const drained = await drainProjection(env, record.user_id, target);
	const finalState = await stub.getProjectionState();
	if (!drained.ok) {
		return json(drained.httpStatus, {
			error: drained.error,
			durable: true,
			retryable: drained.retryable,
			epoch: finalState.epoch,
			head_seq: finalState.head_seq,
			projected_through_seq: finalState.projected_seq,
		});
	}
	return json(200, {
		protocol_version: 1,
		user_id: record.user_id,
		epoch: finalState.epoch,
		head_seq: finalState.head_seq,
		projected_through_seq: finalState.projected_seq,
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		if (pathname === "/internal/v1/projection/drain") {
			if (request.method !== "POST") return errorResponse(405, "use POST");
			return handleRepairDrain(request, env);
		}
		if (pathname === "/internal/v1/sync/metadata") {
			if (request.method !== "POST") return errorResponse(405, "use POST");
			return handleMetadataRead(request, env);
		}
		if (pathname === "/internal/v1/sync/device-name") {
			if (request.method !== "POST") return errorResponse(405, "use POST");
			return handleDeviceRename(request, env);
		}
		if (pathname === "/internal/v1/sync/reset") {
			if (request.method !== "POST") return errorResponse(405, "use POST");
			return handleHubReset(request, env);
		}

		if (
			pathname !== "/v1/sync/ops" &&
			pathname !== "/v1/sync/changes" &&
			pathname !== "/v1/sync/status" &&
			pathname !== "/v1/sync/ws"
		) {
			return errorResponse(404, "not found");
		}

		// Kill switch (plan Phase 5 task 2): one KV read per request, through
		// the per-isolate cache (KILL_SWITCH_CACHE_MS). Tripped ⇒ WS upgrades
		// refused below and every HTTP sync response is stamped
		// `X-Sync-Mode: poll` — the pushes and pulls themselves KEEP WORKING
		// (poll mode degrades latency, never correctness). Read BEFORE
		// authenticate so auth-FAILURE responses are stamped too: incidents
		// correlate, and a tripped switch during a degraded verify upstream
		// (everything 401/503ing) must still tell clients "poll" — an
		// unstamped error response must never read as "switch cleared".
		const killSwitch = await readKillSwitch(env);

		const auth = await authenticateRequest(request, env);
		if (!auth.ok) {
			if (killSwitch.tripped) {
				auth.response.headers.set(SYNC_MODE_HEADER, SYNC_MODE_POLL);
			}
			return auth.response;
		}

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
			if (killSwitch.tripped) {
				// Refused HERE, before the DO is ever woken: the whole point of
				// the switch is un-pinning DOs. 503 + a JSON body clients
				// recognize ({mode: "poll"}); clients suppress reconnects until
				// the header disappears from their HTTP responses.
				const refusal = json(503, {
					error: "sync websocket disabled — hub is in poll mode",
					mode: SYNC_MODE_POLL,
				});
				refusal.headers.set(SYNC_MODE_HEADER, SYNC_MODE_POLL);
				return refusal;
			}
			const stub = env.SYNC_HUB.getByName(auth.userId);
			return stub.fetch(request);
		}

		// All non-WS routes funnel through one point so the poll-mode header
		// rides EVERY HTTP sync response (success and error alike) while the
		// switch is tripped — the header is the clients' only mode signal.
		const response = await (async (): Promise<Response> => {
			if (pathname === "/v1/sync/ops") {
				if (request.method !== "POST") return errorResponse(405, "use POST");
				if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
				return handlePushOps(request, env, auth.userId, auth.deviceId, auth.deviceName);
			}

			if (pathname === "/v1/sync/changes") {
				if (request.method !== "GET") return errorResponse(405, "use GET");
				if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
				return handleGetChanges(url, env, auth.userId, auth.deviceId, auth.deviceName);
			}

			// /v1/sync/status
			if (request.method !== "GET") return errorResponse(405, "use GET");
			return handleGetStatus(env, auth.userId, auth.deviceId, auth.deviceName);
		})();
		if (killSwitch.tripped) {
			response.headers.set(SYNC_MODE_HEADER, SYNC_MODE_POLL);
		}
		return response;
	},

	/**
	 * Scheduled entrypoint — TWO crons (wrangler.jsonc), dispatched on
	 * event.cron. Both live in the stateless Worker — the DO stays I/O-free —
	 * and both are anchored to controller.scheduledTime (not Date.now()) so a
	 * delayed invocation still measures the window it was scheduled for.
	 *
	 *   every-5-minutes (CONTROL_PLANE_PROBE_CRON) — control-plane uptime
	 *     probe (launch Phase 5 task 4, src/control-plane-probe.ts): is
	 *     cmem.ai's DB-backed verify endpoint still rejecting a bogus token
	 *     with 401/403 + JSON? Pages Discord with anti-flap KV state when it
	 *     is not.
	 *   "7 * * * *" (and any unrecognized cron) — hourly watchdog (plan
	 *     Phase 5 task 1, src/watchdog.ts). A persisting breach re-alerts on
	 *     every hourly run — intended (silence would hide an ongoing
	 *     incident).
	 *
	 * Both runners never throw by contract; the probe is ADDITIONALLY wrapped
	 * in the one permitted top-level try/catch (mirroring how the watchdog
	 * isolates itself) so even a probe implementation bug cannot escape the
	 * scheduled handler — and can never affect the sync routes either way.
	 */
	async scheduled(controller, env, _ctx): Promise<void> {
		if (controller.cron === CONTROL_PLANE_PROBE_CRON) {
			try {
				const result = await runControlPlaneProbe(env, {
					now: () => controller.scheduledTime,
				});
				console.log("sync-hub control-plane probe:", JSON.stringify(result));
			} catch (e) {
				console.error("sync-hub control-plane probe crashed:", e);
			}
			return;
		}
		const result = await runWatchdog(env, { now: () => controller.scheduledTime });
		console.log("sync-hub watchdog:", JSON.stringify(result));
	},
} satisfies ExportedHandler<Env>;
