import { afterAll } from "bun:test";
import { loadEnv, type SyncApiEnv } from "../src/env";
import { startSyncApi, type SyncApiApp } from "../src/index";
import {
	canonicalJson,
	sha256Base64Url,
	stableDocumentId,
	wrapCanonicalBody,
	type CanonicalContentBody,
	type CanonicalWireOp,
} from "../src/canonical-content";

export const PROJECTOR_SECRET = "test-projector-secret";
export const DEFAULT_DATABASE_URL =
	process.env.DATABASE_URL
	?? "postgres://postgres:postgres@127.0.0.1:5432/sync_api_test";

export interface ProjectionRequest {
	protocol_version: number;
	user_id: string;
	epoch: string;
	from_seq_exclusive: string;
	through_seq: string;
	ops: Array<{ seq: string; body: string; operation_sha256: string }>;
}

export interface SidecarState {
	verifyCalls: number;
	projectionCalls: ProjectionRequest[];
	denied: number;
}

export function startSidecar(): {
	server: ReturnType<typeof Bun.serve>;
	state: SidecarState;
	baseUrl: string;
} {
	const state: SidecarState = { verifyCalls: 0, projectionCalls: [], denied: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			if (url.pathname === "/verify") {
				state.verifyCalls++;
				const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
				const userId = (request.headers.get("X-User-Id") ?? "").trim();
				if (token === "denied") {
					state.denied++;
					return Response.json({ error: "denied" }, { status: 401 });
				}
				if (token === "wrong-user") {
					return Response.json({ userId: "someone-else" });
				}
				if (token === "no-id") {
					return Response.json({ ok: true });
				}
				if (token.startsWith("valid-for:")) {
					return Response.json({ userId: token.slice("valid-for:".length) });
				}
				if (token.startsWith("snake-for:")) {
					return Response.json({ user_id: token.slice("snake-for:".length) });
				}
				if (token.length > 0 && userId.length > 0) {
					return Response.json({ userId });
				}
				return Response.json({ error: "denied" }, { status: 401 });
			}
			if (url.pathname === "/project") {
				if (request.headers.get("Authorization") !== `Bearer ${PROJECTOR_SECRET}`) {
					return Response.json({ error: "denied" }, { status: 401 });
				}
				const payload = await request.json() as ProjectionRequest;
				state.projectionCalls.push(payload);
				return Response.json({
					protocol_version: 1,
					epoch: payload.epoch,
					projected_through_seq: payload.through_seq,
				});
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	return { server, state, baseUrl: `http://127.0.0.1:${server.port}` };
}

export async function startTestApp(): Promise<{
	app: SyncApiApp;
	sidecar: ReturnType<typeof startSidecar>;
	env: SyncApiEnv;
}> {
	const sidecar = startSidecar();
	const env = loadEnv({
		DATABASE_URL: DEFAULT_DATABASE_URL,
		TOKEN_VERIFY_URL: `${sidecar.baseUrl}/verify`,
		INTERNAL_PROJECTOR_URL: `${sidecar.baseUrl}/project`,
		CMEM_INTERNAL_PROJECTOR_SECRET: PROJECTOR_SECRET,
		AUTH_CACHE_TTL_SECONDS: "900",
		PORT: "0",
		HOST: "127.0.0.1",
	});
	const app = await startSyncApi(env);
	return { app, sidecar, env };
}

export function authHeaders(userId: string, deviceId?: string, token?: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token ?? `valid-for:${userId}`}`,
		"X-User-Id": userId,
		...(deviceId ? { "X-Device-Id": deviceId } : {}),
	};
}

export async function observationOp(
	originLocalId: string,
	entityRev = "1",
	originDeviceId = "dev-a",
	overrides: Record<string, unknown> = {},
): Promise<CanonicalWireOp> {
	const payload: Record<string, unknown> = {
		created_at: "2026-07-20T12:34:56.789Z",
		created_at_epoch: "1784550896789",
		memory_session_id: "memory-test",
		project: "/test/project",
		type: "discovery",
		text: `observation ${originLocalId}`,
		...overrides,
	};
	const body: CanonicalContentBody = {
		body_schema_version: 1,
		deleted: false,
		deleted_at: null,
		entity_rev: entityRev,
		id: await stableDocumentId("observation", originDeviceId, originLocalId),
		kind: "observation",
		mutation: null,
		origin_device_id: originDeviceId,
		origin_local_id: originLocalId,
		payload,
		payload_schema_version: 2,
		payload_sha256: await sha256Base64Url(canonicalJson(payload)),
	};
	return wrapCanonicalBody(body);
}

export function uniqueUser(): string {
	return `user-${crypto.randomUUID()}`;
}

const apps: Array<{ app: SyncApiApp; sidecar: ReturnType<typeof startSidecar> }> = [];

export async function trackedApp(): Promise<ReturnType<typeof startTestApp>> {
	const started = await startTestApp();
	apps.push(started);
	return started;
}

afterAll(async () => {
	for (const started of apps) {
		await started.app.stop();
		started.sidecar.server.stop(true);
	}
	apps.length = 0;
});
