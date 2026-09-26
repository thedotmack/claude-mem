/**
 * Token verification against the Pro app. Same contract as workers/sync-hub:
 * Bearer + X-User-Id, bind to canonical user id, cache positive verdicts.
 * In-memory only (no KV).
 */
import {
	AUTH_CACHE_TTL_DEFAULT_SECONDS,
	AUTH_CACHE_TTL_MAX_SECONDS,
	AUTH_CACHE_TTL_MIN_SECONDS,
	type SyncApiEnv,
} from "./env";

const encoder = new TextEncoder();

export function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function errorResponse(status: number, error: string): Response {
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

export interface AuthDependencies {
	readCachedVerdict(cacheKey: string): Promise<string | null>;
	cacheVerifiedVerdict(cacheKey: string, ttlSeconds: number): Promise<void>;
	invalidateCachedVerdict(cacheKey: string): Promise<void>;
	verifyToken(request: Request): Promise<Response>;
	logCacheFailure(operation: "get" | "put" | "delete", error: unknown): void;
}

interface MemoryVerdict {
	expiresAtMs: number;
}

const verdictMemory = new Map<string, MemoryVerdict>();
const MEMORY_KV_HINT_SECONDS = 60;

function readVerdictMemory(cacheKey: string, nowMs = Date.now()): boolean {
	const entry = verdictMemory.get(cacheKey);
	if (!entry) return false;
	if (entry.expiresAtMs <= nowMs) {
		verdictMemory.delete(cacheKey);
		return false;
	}
	return true;
}

function writeVerdictMemory(cacheKey: string, ttlSeconds: number, nowMs = Date.now()): void {
	verdictMemory.set(cacheKey, { expiresAtMs: nowMs + ttlSeconds * 1_000 });
}

function deleteVerdictMemory(cacheKey: string): void {
	verdictMemory.delete(cacheKey);
}

export function __resetAuthVerdictMemoryForTests(): void {
	verdictMemory.clear();
}

export function defaultAuthDependencies(_env: SyncApiEnv): AuthDependencies {
	return {
		async readCachedVerdict(cacheKey) {
			return readVerdictMemory(cacheKey) ? "1" : null;
		},
		async cacheVerifiedVerdict(cacheKey, ttlSeconds) {
			if (readVerdictMemory(cacheKey)) return;
			writeVerdictMemory(cacheKey, ttlSeconds);
		},
		async invalidateCachedVerdict(cacheKey) {
			deleteVerdictMemory(cacheKey);
		},
		verifyToken: (request) => fetch(request),
		logCacheFailure(operation, error) {
			console.warn("sync-hub auth cache unavailable:", {
				operation,
				errorName: error instanceof Error ? error.name : "unknown",
			});
		},
	};
}

export async function verdictCacheKey(userId: string, token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`${userId}\n${token}`),
	);
	const bytes = Array.from(new Uint8Array(digest));
	return `verdict:${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

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

function parseBoundedPositiveInteger(raw: string, maximum: number): number | null {
	if (!/^[1-9][0-9]*$/.test(raw)) return null;
	let value = 0;
	for (const digit of raw) {
		value = (value * 10) + (digit.charCodeAt(0) - 48);
		if (value > maximum) return maximum;
	}
	return value;
}

export function cacheTtlSeconds(env: SyncApiEnv): number {
	const parsed = parseBoundedPositiveInteger(env.AUTH_CACHE_TTL_SECONDS ?? "", AUTH_CACHE_TTL_MAX_SECONDS);
	if (parsed === null) return AUTH_CACHE_TTL_DEFAULT_SECONDS;
	return Math.min(
		AUTH_CACHE_TTL_MAX_SECONDS,
		Math.max(AUTH_CACHE_TTL_MIN_SECONDS, parsed),
	);
}

const INVALID_TOKEN_MESSAGE =
	"This sync token is no longer valid. Reconnect at https://cmem.ai (Connect) to resume cloud sync.";
const SUBSCRIPTION_INACTIVE_MESSAGE =
	"Your CMEM Pro subscription is not active. Renew at https://cmem.ai/pro to resume cloud sync.";

/**
 * Map the Pro verify rejection to a stable client contract. The plugin stops
 * retrying on any 401/403 and shows `message`; `code` tells a lapsed plan
 * (renew) apart from a revoked/rotated token (reconnect). `error` stays
 * "invalid token" / "subscription inactive" for older clients that match on it.
 */
export async function authRejection(verifyRes: Response): Promise<Response> {
	let code: unknown = null;
	let status: unknown = null;
	try {
		const data = (await verifyRes.json()) as Record<string, unknown> | null;
		if (data && typeof data === "object") {
			code = data.code;
			status = data.status;
			if (code === undefined && data.error === "Subscription not active") code = "subscription_inactive";
		}
	} catch {
		// Non-JSON body: fall through to invalid_token.
	}
	if (code === "subscription_inactive") {
		return json(403, {
			code: "subscription_inactive",
			error: "subscription inactive",
			status: typeof status === "string" ? status : null,
			message: SUBSCRIPTION_INACTIVE_MESSAGE,
		});
	}
	return json(401, { code: "invalid_token", error: "invalid token", message: INVALID_TOKEN_MESSAGE });
}

export async function authenticateRequest(
	request: Request,
	env: SyncApiEnv,
	dependencies: AuthDependencies = defaultAuthDependencies(env),
): Promise<AuthOk | AuthFail> {
	const authHeader = request.headers.get("Authorization") ?? "";
	const userId = (request.headers.get("X-User-Id") ?? "").trim();
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
		try {
			await dependencies.cacheVerifiedVerdict(cacheKey, cacheTtlSeconds(env));
		} catch (error) {
			dependencies.logCacheFailure("put", error);
		}
		return { ok: true, userId, deviceId, deviceName };
	}
	if (verifyRes.status === 401 || verifyRes.status === 403 || verifyRes.status === 402) {
		try {
			await dependencies.invalidateCachedVerdict(cacheKey);
		} catch (error) {
			dependencies.logCacheFailure("delete", error);
		}
		return { ok: false, response: await authRejection(verifyRes) };
	}
	return {
		ok: false,
		response: errorResponse(503, `token verification failed (${verifyRes.status})`),
	};
}

export { MEMORY_KV_HINT_SECONDS, writeVerdictMemory, readVerdictMemory };
