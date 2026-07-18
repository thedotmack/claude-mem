/**
 * SyncHub — one SQLite-backed Durable Object per user, holding that user's
 * ordered op log (Phase 1 of the two-lane sync plan).
 *
 * Contract (plan Phase 1, tasks 3-7; Phase 4 task 1):
 *   - ops table: append-only log with a monotonic `seq` cursor; the
 *     `ops_entity` unique index makes pushes idempotent (duplicate push of the
 *     same (origin_device, kind, origin_id, rev) returns the existing seq).
 *   - RPC for everything durable — the front Worker calls
 *     pushOps/getChanges/getStatus on the stub. The ONE non-RPC path is the
 *     WebSocket upgrade (Phase 4): the HTTP handler below serves ONLY valid
 *     upgrade requests and answers 426 to anything else. Nothing durable
 *     rides the socket (prime directive #2) — frames are advisory hints; the
 *     HTTP cursor lanes remain the sole source of truth, and deleting the
 *     socket path entirely leaves Phase 3 behavior intact.
 *   - Hibernating WS API only (anti-pattern #1): ctx.acceptWebSocket + the
 *     class handler methods below — never the legacy per-socket API.
 *     ctx.getWebSockets() IS the socket registry (anti-pattern #5: no
 *     in-memory maps — they die on hibernation); attachments carry keys only
 *     (device_id, 16 KB max), never state.
 *   - NO outbound I/O of any kind from this class (anti-pattern #3): token
 *     verification and every upstream call live in the stateless front Worker.
 *   - No JS timers (anti-pattern #2): the only scheduling primitive is the
 *     storage alarm, used for daily compaction.
 *   - Cursors are consumed synchronously (`.toArray()` before any await —
 *     never iterate a cursor across an await).
 */

import { DurableObject } from "cloudflare:workers";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Server-side backstop for the per-row body size, sized against the live
 * durable-objects/platform/limits page (fetched 2026-07-18): "Maximum string,
 * BLOB or table row size" is "2 MB", and the page pins the platform to
 * decimal units ("1 GB = 1,000,000,000 bytes ... not a gibibyte"), so the
 * hard limit is 2,000,000 bytes. We cap the body 10,000 bytes below it so
 * that body + sibling columns (kind ≤ 11 B, origin_device/origin_id,
 * rev/server_ts integers) can never reach the row limit: an op that passes
 * this validation cannot die later inside SQLite. The client clamps far
 * below this; this is defense-in-depth.
 */
const MAX_BODY_BYTES = 1_990_000;

/** Page cap for getChanges (plan Phase 1 task 4). */
const MAX_PAGE = 500;

/**
 * Advisory fan-out thresholds (plan Phase 4 task 1). A committed push whose
 * new ops exceed either bound is announced as a bare
 * `{type:'advance', head_seq}` instead of an op frame — replicas then pull
 * the pages over HTTP (frame size discipline: never serialize unbounded data
 * onto a socket; per-op bodies are already capped at MAX_BODY_BYTES but a
 * multi-op frame needs a total budget too).
 */
const ADVANCE_MAX_OPS = 100;
const ADVANCE_MAX_FRAME_BYTES = 262_144; // 256 KiB serialized frame budget

/**
 * SQLite in Durable Objects allows at most 100 bound parameters per statement.
 * Each ops row binds 6 params (kind, origin_device, origin_id, rev, body,
 * server_ts), so 16 rows = 96 params is the largest chunk that fits.
 */
const OP_INSERT_PARAMS = 6;
const INSERT_CHUNK = Math.floor(100 / OP_INSERT_PARAMS); // = 16

export type OpKind = "observation" | "summary" | "prompt" | "mutation";

const OP_KINDS: ReadonlySet<string> = new Set([
	"observation",
	"summary",
	"prompt",
	"mutation",
]);

/** Mutation envelope ops the hub accepts (application is client-side). */
const MUTATION_OPS: ReadonlySet<string> = new Set([
	"set_title",
	"set_prompt_session",
	"remap_project",
]);

/** One op as pushed by a device. `body` is canonical row JSON. */
export interface PushOp {
	kind: OpKind;
	/** Device-local rowid (stringified) for row ops; op UUID for mutations. */
	origin_id: string;
	/** Entity revision; defaults to 1. Higher rev supersedes lower. */
	rev?: number;
	/** Canonical row JSON — either pre-serialized or a plain object. */
	body: string | Record<string, unknown>;
}

export interface AckedOp {
	kind: OpKind;
	origin_id: string;
	rev: number;
	seq: number;
}

export interface PushResult {
	acked: AckedOp[];
	head_seq: number;
}

/**
 * Structured refusal for invalid batches. Returned (not thrown) because a
 * thrown error inside a DO RPC method is reported as an unhandled error by
 * the workers test pool even when the caller handles the rejection; expected
 * validation outcomes ride the return value, only genuine bugs throw.
 */
export interface PushRefusal {
	refused: true;
	/** Always starts with `invalid_ops:`. */
	error: string;
}

export type PushOutcome = PushResult | PushRefusal;

export interface ChangeOp {
	seq: number;
	kind: OpKind;
	origin_device: string;
	origin_id: string;
	rev: number;
	body: string;
	server_ts: number;
}

export interface ChangesResult {
	epoch: string;
	ops: ChangeOp[];
	head_seq: number;
	more: boolean;
}

export interface StatusResult {
	epoch: string;
	head_seq: number;
	op_count: number;
	device_count: number;
}

/**
 * Validation failures carry this prefix (in a PushRefusal, or in the thrown
 * error for malformed direct RPC use); the front Worker maps the prefix to
 * HTTP 400 (anything else is a 500).
 */
export const INVALID_OPS_PREFIX = "invalid_ops:";

function invalid(message: string): Error {
	return new Error(`${INVALID_OPS_PREFIX} ${message}`);
}

interface ValidatedOp {
	kind: OpKind;
	origin_id: string;
	rev: number;
	body: string;
}

const encoder = new TextEncoder();

/** Validate one pushed op; returns the canonical row or throws invalid_ops. */
function validateOp(op: unknown, index: number): ValidatedOp {
	if (typeof op !== "object" || op === null || Array.isArray(op)) {
		throw invalid(`ops[${index}] is not an object`);
	}
	const o = op as Record<string, unknown>;

	if (typeof o.kind !== "string" || !OP_KINDS.has(o.kind)) {
		throw invalid(`ops[${index}].kind must be one of ${[...OP_KINDS].join("|")}`);
	}
	const kind = o.kind as OpKind;

	if (typeof o.origin_id !== "string" || o.origin_id.length === 0) {
		throw invalid(`ops[${index}].origin_id must be a non-empty string`);
	}

	let rev = 1;
	if (o.rev !== undefined) {
		if (typeof o.rev !== "number" || !Number.isInteger(o.rev) || o.rev < 1) {
			throw invalid(`ops[${index}].rev must be a positive integer`);
		}
		rev = o.rev;
	}

	let body: string;
	if (typeof o.body === "string") {
		if (o.body.length === 0) throw invalid(`ops[${index}].body is empty`);
		body = o.body;
	} else if (typeof o.body === "object" && o.body !== null) {
		body = JSON.stringify(o.body);
	} else {
		throw invalid(`ops[${index}].body must be a JSON string or object`);
	}

	if (encoder.encode(body).length > MAX_BODY_BYTES) {
		throw invalid(`ops[${index}].body exceeds ${MAX_BODY_BYTES} bytes`);
	}

	if (kind === "mutation") {
		validateMutationBody(body, index);
	}

	return { kind, origin_id: o.origin_id, rev, body };
}

/**
 * Mutation ops carry `{op: 'set_title'|'set_prompt_session'|'remap_project',
 * target|where, fields}`. The hub only stores them (application is
 * client-side), but it refuses envelopes it cannot parse — in particular
 * unparseable remap_project predicates (plan Phase 1 task 6).
 */
function validateMutationBody(body: string, index: number): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw invalid(`ops[${index}] mutation body is not parseable JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw invalid(`ops[${index}] mutation body must be a JSON object`);
	}
	const m = parsed as Record<string, unknown>;
	if (typeof m.op !== "string" || !MUTATION_OPS.has(m.op)) {
		throw invalid(
			`ops[${index}] mutation op must be one of ${[...MUTATION_OPS].join("|")}`,
		);
	}
	if (typeof m.fields !== "object" || m.fields === null || Array.isArray(m.fields)) {
		throw invalid(`ops[${index}] mutation is missing a fields object`);
	}
	if (m.op === "remap_project") {
		// Predicate sanity cap: a remap the hub can't parse is refused outright.
		if (typeof m.where !== "object" || m.where === null || Array.isArray(m.where)) {
			throw invalid(`ops[${index}] remap_project requires a parseable where predicate`);
		}
	} else if (m.target === undefined && m.where === undefined) {
		throw invalid(`ops[${index}] mutation requires a target or where`);
	}
}

export class SyncHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// App-level keepalive for future browser clients (browsers cannot send
		// protocol-level pings): answered by the runtime without waking a
		// hibernated DO. Protocol-level pings (what the Bun client sends) are
		// auto-ponged by the runtime with no configuration at all.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		// Schema init before any request is delivered (plan Phase 0.1 SQL row).
		ctx.blockConcurrencyWhile(async () => {
			// NOTE: no content may trail the final semicolon (workerd's
			// multi-statement exec rejects a trailing comment-only segment
			// with "SQL code did not contain a statement").
			ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS ops (
					seq           INTEGER PRIMARY KEY AUTOINCREMENT,
					kind          TEXT NOT NULL,            -- 'observation'|'summary'|'prompt'|'mutation'
					origin_device TEXT NOT NULL,
					origin_id     TEXT NOT NULL,            -- device-local rowid; op UUID for mutations
					rev           INTEGER NOT NULL DEFAULT 1,
					body          TEXT NOT NULL,            -- canonical row JSON (opaque-able later for E2E)
					server_ts     INTEGER NOT NULL
				);
				CREATE UNIQUE INDEX IF NOT EXISTS ops_entity ON ops(origin_device, kind, origin_id, rev);
				CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, name TEXT, last_ack_seq INTEGER DEFAULT 0, last_seen INTEGER);
				-- meta holds epoch and counters
				CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`,
			);
			const epoch = ctx.storage.sql
				.exec("SELECT v FROM meta WHERE k = 'epoch'")
				.toArray();
			if (epoch.length === 0) {
				ctx.storage.sql.exec(
					"INSERT INTO meta (k, v) VALUES ('epoch', ?)",
					crypto.randomUUID(),
				);
			}
			// Anti-pattern #4 guard: ALWAYS getAlarm()-check before setting in
			// the constructor — never unconditionally setAlarm() here.
			const scheduled = await ctx.storage.getAlarm();
			if (scheduled === null) {
				await ctx.storage.setAlarm(Date.now() + DAY_MS);
			}
		});
	}

	// -----------------------------------------------------------------------
	// Advisory WebSocket (plan Phase 4 task 1) — the ONE non-RPC path
	// -----------------------------------------------------------------------

	/**
	 * WebSocket upgrade handler (hibernation example shape, Phase 0.1 WS row).
	 * Accepts ONLY valid upgrade requests — anything else is 426. The front
	 * Worker has already authenticated the request and bound the canonical
	 * user id to this DO; the device id rides the same X-Device-Id header the
	 * HTTP lanes use and is stored as the socket's attachment (keys only —
	 * 16 KB max — never state).
	 */
	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get("Upgrade");
		if (!upgradeHeader || upgradeHeader !== "websocket") {
			return new Response("SyncHub expected Upgrade: websocket", { status: 426 });
		}
		// Same trim semantics as the front Worker: "dev-a " and "dev-a" are one
		// device (a forked spelling would defeat the origin-exclusion below).
		const deviceId = (request.headers.get("X-Device-Id") ?? "").trim();
		if (deviceId.length === 0) {
			return new Response("missing X-Device-Id header", { status: 400 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// acceptWebSocket (NOT the legacy per-socket API) marks the socket
		// hibernatable: the runtime may evict this DO while the connection
		// stays open, recreating it (constructor + attachment) on activity.
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ device_id: deviceId });

		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * The advisory lane is downstream-only: incoming messages are ignored
	 * (app-level "ping" never reaches here — setWebSocketAutoResponse answers
	 * it without waking the DO; anything else a client sends is a no-op —
	 * remember incoming messages bill 20:1 while outgoing frames are free).
	 */
	webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): void {
		// Deliberately empty — nothing durable ever rides the socket.
	}

	webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
		// Nothing to clean up: getWebSockets() is the registry and drops closed
		// sockets itself, and the runtime auto-replies to Close frames on this
		// compatibility date. Attachments die with the socket.
	}

	webSocketError(_ws: WebSocket, _error: unknown): void {
		// Advisory socket: an errored peer simply stops receiving hints; the
		// HTTP lanes are unaffected.
	}

	/**
	 * Fan out a committed push to every hibernating/live socket EXCEPT the
	 * origin device (plan Phase 4 task 1). One frame per socket per push —
	 * this per-push-call batching IS the coalescing (timers are banned in the
	 * DO, and a push already batches the burst client-side). Big pushes fall
	 * back to a bare advance frame (thresholds above). Every send is guarded:
	 * a dead socket must NEVER fail the push — the push is durable, the
	 * socket is advisory, and this method swallows everything.
	 */
	private fanOutCommitted(originDeviceId: string, headBefore: number): void {
		try {
			const sockets = this.ctx.getWebSockets();
			if (sockets.length === 0) return;

			const sql = this.ctx.storage.sql;
			// Gate BEFORE materializing anything (anti-pattern #6: never buffer
			// unbounded data in the 128 MB isolate). A push can legally carry
			// multiple ~2 MB bodies; pulling those into JS just to discover the
			// frame is oversized would be a remotely triggerable OOM — so count
			// and size the range in SQL first, and only SELECT the rows when
			// both gates pass.
			const stats = sql
				.exec<{ n: number; body_len: number }>(
					"SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS body_len FROM ops WHERE seq > ?",
					headBefore,
				)
				.one();
			if (stats.n === 0) return; // pure replay — replicas already have it

			const epoch = sql
				.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'epoch'")
				.one().v;
			const head = this.headSeq();

			let frame: string;
			if (stats.n > ADVANCE_MAX_OPS || stats.body_len > ADVANCE_MAX_FRAME_BYTES) {
				frame = JSON.stringify({ type: "advance", epoch, head_seq: head });
			} else {
				const ops = sql
					.exec<{
						seq: number;
						kind: string;
						origin_device: string;
						origin_id: string;
						rev: number;
						body: string;
						server_ts: number;
					}>(
						`SELECT seq, kind, origin_device, origin_id, rev, body, server_ts
						 FROM ops WHERE seq > ? ORDER BY seq`,
						headBefore,
					)
					.toArray() as ChangeOp[]; // consumed synchronously — never across an await
				frame = JSON.stringify({ type: "op", epoch, ops });
				if (frame.length > ADVANCE_MAX_FRAME_BYTES) {
					// Backstop: per-op envelope overhead / JSON escaping pushed a
					// bodies-under-budget range over the line.
					frame = JSON.stringify({ type: "advance", epoch, head_seq: head });
				}
			}

			for (const ws of sockets) {
				let deviceId: string | null = null;
				try {
					const attachment = ws.deserializeAttachment() as
						| { device_id?: unknown }
						| null;
					deviceId =
						attachment && typeof attachment.device_id === "string"
							? attachment.device_id
							: null;
				} catch {
					deviceId = null; // unreadable attachment — still worth a hint
				}
				if (deviceId !== null && deviceId === originDeviceId) continue;
				try {
					ws.send(frame);
				} catch {
					// Dead/half-closed socket: the hint is lost, the log is not —
					// the replica's HTTP poll (lane 1) still converges it.
				}
			}
		} catch (e) {
			// The advisory lane must never surface a failure into pushOps — but
			// a systemic fan-out bug silently disabling the whole speed layer
			// must at least be visible in the DO logs.
			console.error("sync-hub fan-out failed (advisory; push unaffected):", e);
		}
	}

	/**
	 * Append a batch of ops for one device. Idempotent: re-pushing an op whose
	 * (origin_device, kind, origin_id, rev) already exists returns the
	 * existing seq (first write wins — body/server_ts are never overwritten).
	 *
	 * The whole batch is validated before anything is written; any invalid op
	 * refuses the entire batch (`invalid_ops:` refusal → HTTP 400 upstream),
	 * so a client bug is loud instead of silently half-applied. Inserts are
	 * chunked so no statement exceeds 100 bound params.
	 */
	pushOps(deviceId: string, ops: PushOp[]): PushOutcome {
		let rows: ValidatedOp[];
		try {
			if (typeof deviceId !== "string" || deviceId.length === 0) {
				throw invalid("deviceId must be a non-empty string");
			}
			if (!Array.isArray(ops)) {
				throw invalid("ops must be an array");
			}
			rows = ops.map((op, i) => validateOp(op, i));
		} catch (e) {
			if (e instanceof Error && e.message.startsWith(INVALID_OPS_PREFIX)) {
				return { refused: true, error: e.message };
			}
			throw e;
		}

		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const acked: AckedOp[] = [];
		// Fan-out baseline: everything with seq beyond this is what THIS push
		// committed (the DO is single-threaded and this method never awaits,
		// so no other push can interleave between here and the send below).
		const headBefore = this.headSeq();

		this.ctx.storage.transactionSync(() => {
			sql.exec(
				`INSERT INTO devices (device_id, last_seen) VALUES (?, ?)
				 ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen`,
				deviceId,
				now,
			);
			for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
				const chunk = rows.slice(i, i + INSERT_CHUNK);
				const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
				const params: (string | number)[] = [];
				for (const r of chunk) {
					params.push(r.kind, deviceId, r.origin_id, r.rev, r.body, now);
				}
				// The no-op DO UPDATE marks conflicting (duplicate) rows so
				// RETURNING yields a seq for every pushed op, new or replayed.
				const returned = sql
					.exec<{ kind: string; origin_id: string; rev: number; seq: number }>(
						`INSERT INTO ops (kind, origin_device, origin_id, rev, body, server_ts)
						 VALUES ${placeholders}
						 ON CONFLICT(origin_device, kind, origin_id, rev) DO UPDATE SET rev = excluded.rev
						 RETURNING kind, origin_id, rev, seq`,
						...params,
					)
					.toArray(); // consumed synchronously — never across an await
				for (const row of returned) {
					acked.push({
						kind: row.kind as OpKind,
						origin_id: row.origin_id,
						rev: row.rev,
						seq: row.seq,
					});
				}
			}
		});

		// Advisory speed layer, AFTER the commit (a frame must never describe
		// uncommitted state) and fully non-fatal (guarded inside).
		this.fanOutCommitted(deviceId, headBefore);

		return { acked, head_seq: this.headSeq() };
	}

	/**
	 * Cursor read: ops with seq > sinceSeq, in seq order, up to `limit` (≤500).
	 * A device presenting cursor N has by definition applied everything ≤ N,
	 * so sinceSeq doubles as the device's ack — recorded as last_ack_seq (the
	 * compaction watermark is MIN over these).
	 */
	getChanges(deviceId: string, sinceSeq: number, limit: number = MAX_PAGE): ChangesResult {
		if (typeof deviceId !== "string" || deviceId.length === 0) {
			throw invalid("deviceId must be a non-empty string");
		}
		const since =
			typeof sinceSeq === "number" && Number.isFinite(sinceSeq)
				? Math.max(0, Math.floor(sinceSeq))
				: 0;
		const lim =
			typeof limit === "number" && Number.isFinite(limit)
				? Math.min(MAX_PAGE, Math.max(1, Math.floor(limit)))
				: MAX_PAGE;

		const sql = this.ctx.storage.sql;
		const now = Date.now();
		sql.exec(
			`INSERT INTO devices (device_id, last_seen, last_ack_seq) VALUES (?, ?, ?)
			 ON CONFLICT(device_id) DO UPDATE SET
			   last_seen = excluded.last_seen,
			   last_ack_seq = MAX(last_ack_seq, excluded.last_ack_seq)`,
			deviceId,
			now,
			since,
		);

		const epoch = sql
			.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'epoch'")
			.one().v;
		const ops = sql
			.exec<{
				seq: number;
				kind: string;
				origin_device: string;
				origin_id: string;
				rev: number;
				body: string;
				server_ts: number;
			}>(
				`SELECT seq, kind, origin_device, origin_id, rev, body, server_ts
				 FROM ops WHERE seq > ? ORDER BY seq LIMIT ?`,
				since,
				lim,
			)
			.toArray() as ChangeOp[]; // consumed synchronously — never across an await
		const head = this.headSeq();
		const lastSeq = ops.length > 0 ? ops[ops.length - 1].seq : since;
		return {
			epoch,
			ops,
			head_seq: head,
			more: ops.length === lim && lastSeq < head,
		};
	}

	/** Lightweight status for GET /v1/sync/status. */
	getStatus(): StatusResult {
		const sql = this.ctx.storage.sql;
		const epoch = sql
			.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'epoch'")
			.one().v;
		const opCount = sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ops")
			.one().n;
		const deviceCount = sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices")
			.one().n;
		return {
			epoch,
			head_seq: this.headSeq(),
			op_count: opCount,
			device_count: deviceCount,
		};
	}

	/**
	 * Daily compaction (plan Phase 1 task 7): delete ops superseded by a
	 * higher rev of the same entity, but only below the fleet-wide ack
	 * watermark MIN(devices.last_ack_seq) — every device has already applied
	 * (and been superseded past) anything we drop.
	 *
	 * At-least-once + idempotent: the delete is a no-op on re-run. The handler
	 * always reschedules itself so the daily chain survives a failed run
	 * (platform retries handle the failure; the finally keeps the cadence).
	 */
	async alarm(): Promise<void> {
		try {
			this.compact();
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
		}
	}

	private compact(): void {
		const sql = this.ctx.storage.sql;
		const row = sql
			.exec<{ min_ack: number | null }>(
				"SELECT MIN(last_ack_seq) AS min_ack FROM devices",
			)
			.one();
		const minAck = row.min_ack;
		// No devices, or some device has never acked → nothing is provably safe
		// to drop.
		if (minAck === null || minAck <= 0) return;
		sql.exec(
			`DELETE FROM ops
			 WHERE seq <= ?
			   AND EXISTS (
			     SELECT 1 FROM ops AS newer
			     WHERE newer.origin_device = ops.origin_device
			       AND newer.kind = ops.kind
			       AND newer.origin_id = ops.origin_id
			       AND newer.rev > ops.rev
			   )`,
			minAck,
		);
	}

	private headSeq(): number {
		return this.ctx.storage.sql
			.exec<{ head: number }>("SELECT COALESCE(MAX(seq), 0) AS head FROM ops")
			.one().head;
	}
}
