/**
 * Encrypted backup routes (pro-backup plan Phase 3).
 *
 * The client encrypts snapshots with AES-256-GCM using a key that never
 * leaves its machine — BACKUP_BUCKET only ever holds ciphertext. R2 presigned
 * URLs are not available through the binding API, so "upload-url" hands back
 * a Worker-hosted PUT endpoint instead: the request body streams straight
 * into `BACKUP_BUCKET.put(key, request.body)` (never buffered here).
 *
 * AUTH: index.ts runs the same authenticateRequest as /v1/sync/* BEFORE any
 * handler in this file executes; every object key is namespaced under
 * `backups/<userId>/…` and read/delete verify that prefix, so one verified
 * user can never touch another user's objects.
 *
 * Routes (all under the caller's verified userId):
 *   POST   /v1/backup/upload-url       → {key, url} (url = PUT endpoint below)
 *   PUT    /v1/backup/object/<id>      → streamed upload, ≤ BACKUP_MAX_BYTES
 *                                        (413 above), then per-device trim to
 *                                        BACKUP_RETAIN_CLOUD newest objects
 *   GET    /v1/backup/list             → {objects: [{key, size, uploaded}]}
 *   GET    /v1/backup/download-url?key → the object, streamed (octet-stream)
 *   DELETE /v1/backup/object?key       → prefix-verified delete
 */

const DEFAULT_RETAIN_CLOUD = 10;
const DEFAULT_MAX_BYTES = 2_147_483_648; // 2 GiB

/**
 * Object ids are minted by uploadUrl (ms timestamp + 8 random hex chars) but
 * validated on PUT, so a client-supplied path segment can never smuggle
 * separators or dots into the R2 key.
 */
const OBJECT_ID_PATTERN = /^[0-9]{10,16}-[0-9a-f]{8}$/;

/** The subset of authenticateRequest's success result these handlers need. */
export interface BackupAuthContext {
	userId: string;
	deviceId: string | null;
}

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(status: number, error: string): Response {
	return json(status, { error });
}

function userPrefix(userId: string): string {
	return `backups/${userId}/`;
}

function devicePrefix(userId: string, deviceId: string): string {
	return `backups/${userId}/${deviceId}/`;
}

function mintObjectId(): string {
	const random = new Uint8Array(4);
	crypto.getRandomValues(random);
	const hex = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${Date.now()}-${hex}`;
}

function retainCloud(env: Env): number {
	const parsed = Number.parseInt(env.BACKUP_RETAIN_CLOUD ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETAIN_CLOUD;
}

function maxBytes(env: Env): number {
	const parsed = Number.parseInt(env.BACKUP_MAX_BYTES ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/** Every object under a prefix (R2 list pages at 1000 objects). */
async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
	return objects;
}

/**
 * Keep the newest retain objects for this device; delete the rest. Object
 * ids start with a 13-digit ms timestamp, so ascending key order is
 * chronological order.
 */
async function trimDeviceRetention(env: Env, userId: string, deviceId: string): Promise<number> {
	const retain = retainCloud(env);
	const objects = await listAllObjects(env.BACKUP_BUCKET, devicePrefix(userId, deviceId));
	objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const excess = objects.slice(0, Math.max(0, objects.length - retain));
	for (const object of excess) {
		await env.BACKUP_BUCKET.delete(object.key);
	}
	return excess.length;
}

async function handleUploadUrl(url: URL, auth: BackupAuthContext): Promise<Response> {
	if (auth.deviceId === null) {
		return errorResponse(400, "missing X-Device-Id header");
	}
	const id = mintObjectId();
	return json(200, {
		key: `${devicePrefix(auth.userId, auth.deviceId)}${id}.db.enc`,
		url: `${url.origin}/v1/backup/object/${id}`,
	});
}

async function handleObjectPut(
	request: Request,
	env: Env,
	auth: BackupAuthContext,
	id: string,
): Promise<Response> {
	if (auth.deviceId === null) {
		return errorResponse(400, "missing X-Device-Id header");
	}
	if (!OBJECT_ID_PATTERN.test(id)) {
		return errorResponse(400, "invalid backup object id");
	}
	const contentLengthRaw = request.headers.get("Content-Length");
	const contentLength = Number.parseInt(contentLengthRaw ?? "", 10);
	if (!Number.isFinite(contentLength) || contentLength < 0) {
		return errorResponse(411, "Content-Length required");
	}
	if (contentLength > maxBytes(env)) {
		return errorResponse(413, `backup exceeds the ${maxBytes(env)}-byte limit`);
	}

	const key = `${devicePrefix(auth.userId, auth.deviceId)}${id}.db.enc`;
	// Streamed straight into R2 — the Worker never buffers the snapshot.
	const object = await env.BACKUP_BUCKET.put(key, request.body ?? "");
	if (object === null) {
		// put() returns null only when onlyIf preconditions fail; none are set
		// here, but fail loudly rather than reporting a phantom success.
		return errorResponse(500, "backup object was not stored");
	}
	const trimmed = await trimDeviceRetention(env, auth.userId, auth.deviceId);
	return json(200, { key, size: object.size, trimmed });
}

async function handleList(env: Env, auth: BackupAuthContext): Promise<Response> {
	const objects = await listAllObjects(env.BACKUP_BUCKET, userPrefix(auth.userId));
	return json(200, {
		objects: objects.map((object) => ({
			key: object.key,
			size: object.size,
			uploaded: object.uploaded.toISOString(),
		})),
	});
}

async function handleDownload(url: URL, env: Env, auth: BackupAuthContext): Promise<Response> {
	const key = url.searchParams.get("key") ?? "";
	if (key === "") return errorResponse(400, "missing key parameter");
	if (!key.startsWith(userPrefix(auth.userId))) {
		return errorResponse(403, "key does not belong to the authenticated user");
	}
	const object = await env.BACKUP_BUCKET.get(key);
	if (object === null) return errorResponse(404, "backup object not found");
	return new Response(object.body, {
		status: 200,
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(object.size),
		},
	});
}

async function handleDelete(url: URL, env: Env, auth: BackupAuthContext): Promise<Response> {
	const key = url.searchParams.get("key") ?? "";
	if (key === "") return errorResponse(400, "missing key parameter");
	if (!key.startsWith(userPrefix(auth.userId))) {
		return errorResponse(403, "key does not belong to the authenticated user");
	}
	await env.BACKUP_BUCKET.delete(key);
	return json(200, { deleted: key });
}

/**
 * Dispatch for /v1/backup/*. index.ts has ALREADY authenticated the request;
 * `auth` is the verified identity.
 */
export async function handleBackupRequest(
	request: Request,
	url: URL,
	env: Env,
	auth: BackupAuthContext,
): Promise<Response> {
	const { pathname } = url;

	if (pathname === "/v1/backup/upload-url") {
		if (request.method !== "POST") return errorResponse(405, "use POST");
		return handleUploadUrl(url, auth);
	}
	if (pathname.startsWith("/v1/backup/object/")) {
		if (request.method !== "PUT") return errorResponse(405, "use PUT");
		return handleObjectPut(request, env, auth, pathname.slice("/v1/backup/object/".length));
	}
	if (pathname === "/v1/backup/object") {
		if (request.method !== "DELETE") return errorResponse(405, "use DELETE");
		return handleDelete(url, env, auth);
	}
	if (pathname === "/v1/backup/list") {
		if (request.method !== "GET") return errorResponse(405, "use GET");
		return handleList(env, auth);
	}
	if (pathname === "/v1/backup/download-url") {
		if (request.method !== "GET") return errorResponse(405, "use GET");
		return handleDownload(url, env, auth);
	}
	return errorResponse(404, "not found");
}
