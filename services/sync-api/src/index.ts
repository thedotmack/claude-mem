/**
 * sync-api — protocol-v2 hub on a long-running HTTP + WebSocket process.
 * Routes and shapes match workers/sync-hub. Storage is Postgres.
 */
import postgres from "postgres";
import { authenticateRequest, errorResponse, json } from "./auth";
import type { SyncApiEnv } from "./env";
import { loadEnv } from "./env";
import {
	decimalAtLeast,
	drainProjection,
	fetchProjectionWithTimeout,
	REPAIR_DRAIN_MAX_PAGES,
} from "./projection";
import { applyMigrations } from "./schema";
import { SocketRegistry, type RegisteredSocket } from "./sockets";
import {
	DEVICE_LIMIT_ERROR,
	HubStore,
	INVALID_OPS_PREFIX,
	PROJECTION_ERROR_PREFIX,
	type PushOp,
} from "./store";

const MAX_OPS_PER_PUSH = 500;
const MAX_PUSH_BODY_BYTES = 8_000_000;
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const STORE_RETRY_AFTER_SECONDS = "5";
const encoder = new TextEncoder();

export { fetchProjectionWithTimeout, drainProjection };

function retryableStoreUnavailable(label: string, error: unknown): Response {
	console.error(`sync-hub ${label} failed:`, error);
	const response = json(503, { error: "sync_hub_unavailable", retryable: true });
	response.headers.set("Retry-After", STORE_RETRY_AFTER_SECONDS);
	return response;
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

function parseBoundedPositiveInteger(raw: string, maximum: number): number | null {
	if (!/^[1-9][0-9]*$/.test(raw)) return null;
	let value = 0;
	for (const digit of raw) {
		value = (value * 10) + (digit.charCodeAt(0) - 48);
		if (value > maximum) return maximum;
	}
	return value;
}

function hasInternalCredential(request: Request, env: SyncApiEnv): boolean {
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

export interface SyncApiApp {
	env: SyncApiEnv;
	sql: postgres.Sql;
	store: HubStore;
	sockets: SocketRegistry;
	server: ReturnType<typeof Bun.serve>;
	url: string;
	stop: () => Promise<void>;
}

interface SocketData {
	userId: string;
	deviceId: string;
	registered: RegisteredSocket | null;
}

async function handlePushOps(
	request: Request,
	app: { env: SyncApiEnv; store: HubStore },
	userId: string,
	deviceId: string,
	deviceName: string | null,
): Promise<Response> {
	const raw = await request.text();
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

	try {
		const result = await app.store.pushOps(userId, deviceId, ops as PushOp[], deviceName);
		if ("refused" in result) {
			return errorResponse(result.error === DEVICE_LIMIT_ERROR ? 409 : 400, result.error);
		}
		const projection = await drainProjection(app.env, app.store, userId, result.head_seq);
		if (projection.ok && decimalAtLeast(projection.projectedSeq, result.head_seq)) {
			return json(200, { ...result, projected_seq: projection.projectedSeq });
		}
		if (projection.ok) {
			return json(503, {
				error: "projection_catching_up",
				durable: true,
				retryable: true,
				head_seq: result.head_seq,
				projected_seq: projection.projectedSeq,
			});
		}
		return json(projection.httpStatus, {
			error: projection.error,
			durable: true,
			retryable: projection.retryable,
			head_seq: result.head_seq,
			projected_seq: projection.projectedSeq,
		});
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleGetChanges(
	url: URL,
	app: { store: HubStore },
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
	try {
		const result = await app.store.getChanges(userId, deviceId, sinceRaw, limit, deviceName);
		if ("refused" in result) return errorResponse(409, result.error);
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleGetStatus(
	app: { store: HubStore },
	userId: string,
	deviceId: string | null,
	deviceName: string | null,
): Promise<Response> {
	try {
		const result = await app.store.getStatus(userId, deviceId, deviceName);
		if ("refused" in result) return errorResponse(409, result.error);
		return json(200, result);
	} catch (e) {
		return mapHubError(e);
	}
}

async function handleMetadataRead(request: Request, app: { env: SyncApiEnv; store: HubStore }): Promise<Response> {
	if (!hasInternalCredential(request, app.env)) return errorResponse(401, "invalid internal credential");
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
		return json(200, await app.store.getMetadata(userId));
	} catch (error) {
		return mapHubError(error);
	}
}

async function handleHubReset(request: Request, app: { env: SyncApiEnv; store: HubStore }): Promise<Response> {
	if (!hasInternalCredential(request, app.env)) return errorResponse(401, "invalid internal credential");
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
		return json(200, await app.store.resetAllState(userId));
	} catch (error) {
		return mapHubError(error);
	}
}

async function handleDeviceRename(request: Request, app: { env: SyncApiEnv; store: HubStore }): Promise<Response> {
	if (!hasInternalCredential(request, app.env)) return errorResponse(401, "invalid internal credential");
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
		const renamed = await app.store.renameDevice(userId, deviceId, name);
		if (!renamed) return errorResponse(404, "device not found");
		return json(200, { protocol_version: 1, user_id: userId, device_id: deviceId, name });
	} catch (error) {
		return mapHubError(error);
	}
}

async function handleRepairDrain(request: Request, app: { env: SyncApiEnv; store: HubStore }): Promise<Response> {
	const expected = `Bearer ${app.env.CMEM_INTERNAL_PROJECTOR_SECRET ?? ""}`;
	if (!app.env.CMEM_INTERNAL_PROJECTOR_SECRET || request.headers.get("Authorization") !== expected) {
		return errorResponse(401, "invalid internal projector credential");
	}
	let body: unknown;
	try { body = await request.json(); } catch { return errorResponse(400, "request body is not JSON"); }
	const record = body as Record<string, unknown> | null;
	if (record?.protocol_version !== 1 || typeof record.user_id !== "string" || record.user_id.length === 0) {
		return errorResponse(400, "expected {protocol_version:1,user_id,through_seq?}");
	}
	let state;
	try {
		state = await app.store.getProjectionState(record.user_id);
	} catch (error) {
		return retryableStoreUnavailable("repair drain", error);
	}
	const target = record.through_seq === undefined ? state.head_seq : record.through_seq;
	if (typeof target !== "string" || !CANONICAL_DECIMAL.test(target)) {
		return errorResponse(400, "through_seq must be a canonical unsigned decimal string");
	}
	if (decimalAtLeast(target, state.head_seq) && target !== state.head_seq) {
		return errorResponse(400, "through_seq exceeds Hub head_seq");
	}
	let drained;
	let finalState;
	try {
		drained = await drainProjection(app.env, app.store, record.user_id, target, {
			maxPages: REPAIR_DRAIN_MAX_PAGES,
		});
		finalState = await app.store.getProjectionState(record.user_id);
	} catch (error) {
		return retryableStoreUnavailable("repair drain", error);
	}
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
	const complete = decimalAtLeast(finalState.projected_seq, target);
	return json(complete ? 200 : 202, {
		protocol_version: 1,
		user_id: record.user_id,
		epoch: finalState.epoch,
		head_seq: finalState.head_seq,
		projected_through_seq: finalState.projected_seq,
	});
}

async function handleHealth(sql: postgres.Sql): Promise<Response> {
	try {
		await sql`SELECT 1 AS ok`;
		return json(200, { ok: true });
	} catch (error) {
		console.error("sync-api health db ping failed:", error);
		return json(503, { ok: false, error: "database unavailable" });
	}
}

export async function startSyncApi(env: SyncApiEnv = loadEnv()): Promise<SyncApiApp> {
	const sql = postgres(env.DATABASE_URL, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10,
	});
	await applyMigrations(sql);
	const sockets = new SocketRegistry();
	const store = new HubStore(sql, sockets);

	const ctx = { env, store, sockets, sql };

	const server = Bun.serve<SocketData>({
		hostname: env.HOST,
		port: env.PORT,
		async fetch(request, server) {
			const url = new URL(request.url);
			const { pathname } = url;

			if (pathname === "/health") {
				if (request.method !== "GET") return errorResponse(405, "use GET");
				return handleHealth(sql);
			}

			if (pathname === "/internal/v1/projection/drain") {
				if (request.method !== "POST") return errorResponse(405, "use POST");
				return handleRepairDrain(request, ctx);
			}
			if (pathname === "/internal/v1/sync/metadata") {
				if (request.method !== "POST") return errorResponse(405, "use POST");
				return handleMetadataRead(request, ctx);
			}
			if (pathname === "/internal/v1/sync/device-name") {
				if (request.method !== "POST") return errorResponse(405, "use POST");
				return handleDeviceRename(request, ctx);
			}
			if (pathname === "/internal/v1/sync/reset") {
				if (request.method !== "POST") return errorResponse(405, "use POST");
				return handleHubReset(request, ctx);
			}

			if (
				pathname !== "/v1/sync/ops" &&
				pathname !== "/v1/sync/changes" &&
				pathname !== "/v1/sync/status" &&
				pathname !== "/v1/sync/ws"
			) {
				return errorResponse(404, "not found");
			}

			const auth = await authenticateRequest(request, env);
			if (!auth.ok) return auth.response;

			if (pathname === "/v1/sync/ws") {
				if (request.method !== "GET") return errorResponse(405, "use GET");
				if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
				const upgradeHeader = request.headers.get("Upgrade");
				if (!upgradeHeader || upgradeHeader !== "websocket") {
					return errorResponse(426, "expected Upgrade: websocket");
				}
				try {
					const accepted = await store.acceptWebSocket(auth.userId, auth.deviceId, auth.deviceName);
					if ("refused" in accepted) {
						return json(409, { error: accepted.error });
					}
				} catch (error) {
					return retryableStoreUnavailable("websocket upgrade", error);
				}
				const upgraded = server.upgrade(request, {
					data: { userId: auth.userId, deviceId: auth.deviceId, registered: null },
				});
				if (!upgraded) return errorResponse(426, "expected Upgrade: websocket");
				return undefined as unknown as Response;
			}

			if (pathname === "/v1/sync/ops") {
				if (request.method !== "POST") return errorResponse(405, "use POST");
				if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
				return handlePushOps(request, ctx, auth.userId, auth.deviceId, auth.deviceName);
			}
			if (pathname === "/v1/sync/changes") {
				if (request.method !== "GET") return errorResponse(405, "use GET");
				if (!auth.deviceId) return errorResponse(400, "missing X-Device-Id header");
				return handleGetChanges(url, ctx, auth.userId, auth.deviceId, auth.deviceName);
			}
			if (request.method !== "GET") return errorResponse(405, "use GET");
			return handleGetStatus(ctx, auth.userId, auth.deviceId, auth.deviceName);
		},
		websocket: {
			open(ws) {
				const registered: RegisteredSocket = {
					userId: ws.data.userId,
					deviceId: ws.data.deviceId,
					send: (data) => { ws.send(data); },
					close: (code, reason) => { ws.close(code, reason); },
				};
				ws.data.registered = registered;
				sockets.add(registered);
			},
			message(ws, message) {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				if (text === "ping") {
					try { ws.send("pong"); } catch { /* closed */ }
				}
			},
			close(ws) {
				if (ws.data.registered) sockets.remove(ws.data.registered);
			},
		},
	});

	const host = env.HOST === "0.0.0.0" ? "127.0.0.1" : env.HOST;
	const url = `http://${host}:${server.port}`;

	const stop = async (): Promise<void> => {
		server.stop(true);
		await sql.end({ timeout: 5 });
	};

	return { env, sql, store, sockets, server, url, stop };
}

const isMain = typeof Bun !== "undefined"
	&& Array.isArray(Bun.main ? [Bun.main] : [])
	&& import.meta.path === Bun.main;

if (isMain) {
	const app = await startSyncApi();
	console.log(JSON.stringify({ event: "ready", url: app.url }));
	const shutdown = async (): Promise<void> => {
		await app.stop();
		console.log(JSON.stringify({ event: "stopped" }));
		process.exit(0);
	};
	process.on("SIGTERM", () => { void shutdown(); });
	process.on("SIGINT", () => { void shutdown(); });
}
