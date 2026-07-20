/**
 * Per-user ordered SyncHub log. The Durable Object performs no outbound I/O:
 * the stateless Worker owns authentication and Turbopuffer projection calls.
 */
import { DurableObject } from "cloudflare:workers";
import {
	assertCanonicalDecimal,
	compareCanonicalDecimals,
	decimalAtLeast,
	decimalMin,
	incrementCanonicalDecimal,
	newEpoch,
	parseCanonicalOperation,
	type CanonicalContentBody,
	type CanonicalKind,
	type CanonicalWireOp,
} from "../canonical-content";
import {
	PROJECTION_PAGE_MAX_BYTES,
	PROJECTION_PAGE_MAX_OPS,
	projectionRequestBytes,
} from "../projection-protocol";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE = 500;
const ADVANCE_MAX_OPS = 100;
const ADVANCE_MAX_FRAME_BYTES = 262_144;
/** 45s Hub abort < 60s Pro platform ceiling < 90s fencing lease. */
export const PROJECTION_LEASE_MS = 90_000;
const encoder = new TextEncoder();

export type PushOp = CanonicalWireOp;

export interface AckedOp {
	id: string;
	kind: CanonicalKind;
	origin_local_id: string | null;
	entity_rev: string;
	operation_sha256: string;
	seq: string;
}

export interface PushResult {
	acked: AckedOp[];
	head_seq: string;
}

export interface PushRefusal {
	refused: true;
	error: string;
}

export type PushOutcome = PushResult | PushRefusal;

export interface ChangeOp {
	seq: string;
	body: string;
	operation_sha256: string;
	server_ts: string;
}

export interface ChangesResult {
	protocol_version: 2;
	epoch: string;
	ops: ChangeOp[];
	head_seq: string;
	more: boolean;
}

export interface StatusResult {
	protocol_version: 2;
	epoch: string;
	head_seq: string;
	projected_seq: string;
	op_count: number;
	device_count: number;
}

export interface ProjectionLease {
	acquired: boolean;
	lease_token?: string;
	epoch: string;
	head_seq: string;
	projected_seq: string;
	target_seq: string;
}

export interface ProjectionPage {
	protocol_version: 1;
	epoch: string;
	from_seq_exclusive: string;
	through_seq: string;
	target_seq: string;
	ops: ChangeOp[];
}

export interface ProjectionState {
	protocol_version: 1;
	epoch: string;
	head_seq: string;
	projected_seq: string;
}

export const INVALID_OPS_PREFIX = "invalid_ops:";
export const PROJECTION_ERROR_PREFIX = "projection_error:";

function invalid(message: string): Error {
	return new Error(`${INVALID_OPS_PREFIX} ${message}`);
}

function projectionError(message: string): Error {
	return new Error(`${PROJECTION_ERROR_PREFIX} ${message}`);
}

interface ValidatedOp {
	body: CanonicalContentBody;
	serialized: string;
	operationSha256: string;
}

interface HeadRow extends Record<string, string | number> {
	entity_rev: string;
	operation_sha256: string;
	deleted: number;
	seq: string;
}

function toChange(row: {
	seq: string;
	body: string;
	operation_sha256: string;
	server_ts: string;
}): ChangeOp {
	return {
		seq: String(row.seq),
		body: row.body,
		operation_sha256: row.operation_sha256,
		server_ts: String(row.server_ts),
	};
}

export class SyncHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS canonical_ops (
					seq                 TEXT PRIMARY KEY,
					entity_id           TEXT NOT NULL,
					kind                TEXT NOT NULL,
					origin_device_id    TEXT NOT NULL,
					origin_local_id     TEXT,
					entity_rev          TEXT NOT NULL,
					operation_sha256    TEXT NOT NULL,
					body                TEXT NOT NULL,
					deleted             INTEGER NOT NULL CHECK (deleted IN (0, 1)),
					server_ts           TEXT NOT NULL
				);
				CREATE UNIQUE INDEX IF NOT EXISTS canonical_ops_entity_rev
					ON canonical_ops(entity_id, entity_rev);
				CREATE TABLE IF NOT EXISTS entity_heads (
					entity_id           TEXT PRIMARY KEY,
					kind                TEXT NOT NULL,
					origin_device_id    TEXT NOT NULL,
					origin_local_id     TEXT,
					entity_rev          TEXT NOT NULL,
					operation_sha256    TEXT NOT NULL,
					deleted             INTEGER NOT NULL CHECK (deleted IN (0, 1)),
					seq                 TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS devices (
					device_id           TEXT PRIMARY KEY,
					name                TEXT,
					last_ack_seq        TEXT NOT NULL DEFAULT '0',
					last_seen           INTEGER
				);
				CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`,
			);
			const defaults: Array<[string, string]> = [
				["epoch", newEpoch()],
				["head_seq", "0"],
				["projected_seq", "0"],
			];
			for (const [key, value] of defaults) {
				ctx.storage.sql.exec(
					"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING",
					key,
					value,
				);
			}
			const scheduled = await ctx.storage.getAlarm();
			if (scheduled === null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
		});
	}

	// ---------------------------------------------------------------------
	// Advisory WebSocket. Frames are hints only; HTTP remains authoritative.
	// ---------------------------------------------------------------------

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("SyncHub expected Upgrade: websocket", { status: 426 });
		}
		const deviceId = (request.headers.get("X-Device-Id") ?? "").trim();
		if (deviceId.length === 0) return new Response("missing X-Device-Id header", { status: 400 });
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ device_id: deviceId });
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): void {}
	webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {}
	webSocketError(_ws: WebSocket, _error: unknown): void {}

	private fanOutCommitted(originDeviceId: string, headBefore: string): void {
		try {
			const sockets = this.ctx.getWebSockets();
			if (sockets.length === 0) return;
			const sql = this.ctx.storage.sql;
			const stats = sql.exec<{ n: number; body_len: number }>(
				`SELECT COUNT(*) AS n,
				        COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS body_len
				 FROM canonical_ops
				 WHERE LENGTH(seq) > LENGTH(?)
				    OR (LENGTH(seq) = LENGTH(?) AND seq > ?)`,
				headBefore,
				headBefore,
				headBefore,
			).one();
			if (stats.n === 0) return;
			const epoch = this.meta("epoch");
			const head = this.headSeq();
			let frame: string;
			if (stats.n > ADVANCE_MAX_OPS || stats.body_len > ADVANCE_MAX_FRAME_BYTES) {
				frame = JSON.stringify({ type: "advance", epoch, head_seq: head });
			} else {
				const rows = sql.exec<{
					seq: string;
					body: string;
					operation_sha256: string;
					server_ts: string;
				}>(
					`SELECT seq, body, operation_sha256, server_ts
					 FROM canonical_ops
					 WHERE LENGTH(seq) > LENGTH(?)
					    OR (LENGTH(seq) = LENGTH(?) AND seq > ?)
					 ORDER BY LENGTH(seq), seq`,
					headBefore,
					headBefore,
					headBefore,
				).toArray();
				frame = JSON.stringify({ type: "op", epoch, ops: rows.map(toChange) });
				if (encoder.encode(frame).length > ADVANCE_MAX_FRAME_BYTES) {
					frame = JSON.stringify({ type: "advance", epoch, head_seq: head });
				}
			}
			for (const ws of sockets) {
				let attachedDevice: string | null = null;
				try {
					const attachment = ws.deserializeAttachment() as { device_id?: unknown } | null;
					attachedDevice = typeof attachment?.device_id === "string" ? attachment.device_id : null;
				} catch {}
				if (attachedDevice === originDeviceId) continue;
				try { ws.send(frame); } catch {}
			}
		} catch (error) {
			console.error("sync-hub fan-out failed (advisory; push unaffected):", error);
		}
	}

	// ---------------------------------------------------------------------
	// Canonical append path and client cursor reads.
	// ---------------------------------------------------------------------

	async pushOps(deviceId: string, ops: PushOp[]): Promise<PushOutcome> {
		let rows: ValidatedOp[];
		try {
			if (typeof deviceId !== "string" || deviceId.length === 0) throw invalid("deviceId must be non-empty");
			if (!Array.isArray(ops)) throw invalid("ops must be an array");
			rows = await Promise.all(ops.map(async (op, index) => {
				try {
					const parsed = await parseCanonicalOperation(op);
					if (parsed.body.origin_device_id !== deviceId) {
						throw new Error("origin_device_id does not match authenticated X-Device-Id");
					}
					return parsed;
				} catch (error) {
					throw invalid(`ops[${index}] ${error instanceof Error ? error.message : String(error)}`);
				}
			}));
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(INVALID_OPS_PREFIX)) {
				return { refused: true, error: error.message };
			}
			throw error;
		}

		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const nowDecimal = String(now);
		const headBefore = this.headSeq();
		const acked: AckedOp[] = [];
		try {
			this.ctx.storage.transactionSync(() => {
				sql.exec(
					`INSERT INTO devices (device_id, last_seen) VALUES (?, ?)
					 ON CONFLICT(device_id) DO UPDATE SET last_seen = excluded.last_seen`,
					deviceId,
					now,
				);
				for (const row of rows) {
					const body = row.body;
					const head = sql.exec<HeadRow>(
						`SELECT entity_rev, operation_sha256, deleted, CAST(seq AS TEXT) AS seq
						 FROM entity_heads WHERE entity_id = ?`,
						body.id,
					).toArray()[0];
					if (head) {
						const order = compareCanonicalDecimals(body.entity_rev, head.entity_rev);
						if (order < 0) throw invalid(`stale_revision:${body.id}:${body.entity_rev}<${head.entity_rev}`);
						if (order === 0) {
							if (row.operationSha256 !== head.operation_sha256) {
								throw invalid(`revision_hash_conflict:${body.id}:${body.entity_rev}`);
							}
							acked.push({
								id: body.id,
								kind: body.kind,
								origin_local_id: body.origin_local_id,
								entity_rev: body.entity_rev,
								operation_sha256: head.operation_sha256,
								seq: String(head.seq),
							});
							continue;
						}
					}

					const seq = incrementCanonicalDecimal(this.headSeq());
					sql.exec(
						`INSERT INTO canonical_ops
						 (seq, entity_id, kind, origin_device_id, origin_local_id, entity_rev,
						  operation_sha256, body, deleted, server_ts)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						seq,
						body.id,
						body.kind,
						body.origin_device_id,
						body.origin_local_id,
						body.entity_rev,
						row.operationSha256,
						row.serialized,
						body.deleted ? 1 : 0,
						nowDecimal,
					);
					sql.exec(
						`INSERT INTO entity_heads
						 (entity_id, kind, origin_device_id, origin_local_id, entity_rev,
						  operation_sha256, deleted, seq)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT(entity_id) DO UPDATE SET
						  kind=excluded.kind, origin_device_id=excluded.origin_device_id,
						  origin_local_id=excluded.origin_local_id, entity_rev=excluded.entity_rev,
						  operation_sha256=excluded.operation_sha256, deleted=excluded.deleted,
						  seq=excluded.seq`,
						body.id,
						body.kind,
						body.origin_device_id,
						body.origin_local_id,
						body.entity_rev,
						row.operationSha256,
						body.deleted ? 1 : 0,
						seq,
					);
					this.setMeta("head_seq", seq);
					acked.push({
						id: body.id,
						kind: body.kind,
						origin_local_id: body.origin_local_id,
						entity_rev: body.entity_rev,
						operation_sha256: row.operationSha256,
						seq,
					});
				}
			});
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(INVALID_OPS_PREFIX)) {
				return { refused: true, error: error.message };
			}
			throw error;
		}

		this.fanOutCommitted(deviceId, headBefore);
		return { acked, head_seq: this.headSeq() };
	}

	getChanges(deviceId: string, sinceSeq: string, limit = MAX_PAGE): ChangesResult {
		if (typeof deviceId !== "string" || deviceId.length === 0) throw invalid("deviceId must be non-empty");
		const since = assertCanonicalDecimal(sinceSeq);
		const lim = Number.isFinite(limit) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(limit))) : MAX_PAGE;
		const head = this.headSeq();
		const acknowledged = decimalMin(since, head);
		const sql = this.ctx.storage.sql;
		const existing = sql.exec<{ last_ack_seq: string }>(
			"SELECT last_ack_seq FROM devices WHERE device_id = ?",
			deviceId,
		).toArray()[0];
		const nextAck = existing && compareCanonicalDecimals(existing.last_ack_seq, acknowledged) > 0
			? existing.last_ack_seq
			: acknowledged;
		sql.exec(
			`INSERT INTO devices (device_id, last_seen, last_ack_seq) VALUES (?, ?, ?)
			 ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen,
			 last_ack_seq=excluded.last_ack_seq`,
			deviceId,
			Date.now(),
			nextAck,
		);
		const rows = sql.exec<{
			seq: string;
			body: string;
			operation_sha256: string;
			server_ts: string;
		}>(
			`SELECT seq, body, operation_sha256, server_ts
			 FROM canonical_ops
			 WHERE LENGTH(seq) > LENGTH(?)
			    OR (LENGTH(seq) = LENGTH(?) AND seq > ?)
			 ORDER BY LENGTH(seq), seq LIMIT ?`,
			since,
			since,
			since,
			lim,
		).toArray();
		const ops = rows.map(toChange);
		const last = ops.length > 0 ? ops[ops.length - 1].seq : since;
		const more = sql.exec<{ n: number }>(
			`SELECT EXISTS(
				SELECT 1 FROM canonical_ops
				WHERE LENGTH(seq) > LENGTH(?)
				   OR (LENGTH(seq) = LENGTH(?) AND seq > ?)
			) AS n`,
			last,
			last,
			last,
		).one().n === 1;
		return {
			protocol_version: 2,
			epoch: this.meta("epoch"),
			ops,
			head_seq: head,
			more,
		};
	}

	getStatus(): StatusResult {
		const sql = this.ctx.storage.sql;
		return {
			protocol_version: 2,
			epoch: this.meta("epoch"),
			head_seq: this.headSeq(),
			projected_seq: this.projectedSeq(),
			op_count: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_ops").one().n,
			device_count: sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n,
		};
	}

	// ---------------------------------------------------------------------
	// Authoritative projection checkpoint and short per-user lease.
	// ---------------------------------------------------------------------

	acquireProjectionLease(targetSeq: string, now = Date.now()): ProjectionLease {
		const target = assertCanonicalDecimal(targetSeq);
		const head = this.headSeq();
		if (compareCanonicalDecimals(target, head) > 0) throw projectionError("target_seq exceeds head_seq");
		const projected = this.projectedSeq();
		const existingToken = this.metaOptional("projection_lease_token");
		const nowValue = this.leaseNow(now);
		const existingExpiry = this.metaOptional("projection_lease_expires_at");
		if (existingToken && existingExpiry && compareCanonicalDecimals(existingExpiry, nowValue) > 0) {
			return {
				acquired: false,
				epoch: this.meta("epoch"),
				head_seq: head,
				projected_seq: projected,
				target_seq: target,
			};
		}
		const token = crypto.randomUUID();
		this.ctx.storage.transactionSync(() => {
			this.setMeta("projection_lease_token", token);
			this.setMeta("projection_lease_expires_at", this.leaseExpiry(nowValue));
		});
		return {
			acquired: true,
			lease_token: token,
			epoch: this.meta("epoch"),
			head_seq: head,
			projected_seq: projected,
			target_seq: target,
		};
	}

	getProjectionPage(
		leaseToken: string,
		targetSeq: string,
		userId: string,
		maxOps = PROJECTION_PAGE_MAX_OPS,
		maxBytes = PROJECTION_PAGE_MAX_BYTES,
		now = Date.now(),
	): ProjectionPage {
		this.assertLease(leaseToken, now);
		if (typeof userId !== "string" || userId.length === 0) throw projectionError("user_id must be non-empty");
		const target = assertCanonicalDecimal(targetSeq);
		const projected = this.projectedSeq();
		const epoch = this.meta("epoch");
		if (compareCanonicalDecimals(target, this.headSeq()) > 0) throw projectionError("target_seq exceeds head_seq");
		const limit = Math.min(PROJECTION_PAGE_MAX_OPS, Math.max(1, Math.floor(maxOps)));
		const byteLimit = Math.min(PROJECTION_PAGE_MAX_BYTES, Math.max(1, Math.floor(maxBytes)));
		const rows = this.ctx.storage.sql.exec<{
			seq: string;
			body: string;
			operation_sha256: string;
			server_ts: string;
		}>(
			`SELECT seq, body, operation_sha256, server_ts
			 FROM canonical_ops
			 WHERE (LENGTH(seq) > LENGTH(?) OR (LENGTH(seq) = LENGTH(?) AND seq > ?))
			   AND (LENGTH(seq) < LENGTH(?) OR (LENGTH(seq) = LENGTH(?) AND seq <= ?))
			 ORDER BY LENGTH(seq), seq LIMIT ?`,
			projected,
			projected,
			projected,
			target,
			target,
			target,
			limit,
		).toArray();
		const ops: ChangeOp[] = [];
		for (const row of rows) {
			const op = toChange(row);
			const candidate = [...ops, op];
			const bytes = projectionRequestBytes({
				userId,
				epoch,
				fromSeqExclusive: projected,
				throughSeq: op.seq,
				ops: candidate,
			});
			if (bytes > byteLimit) {
				if (ops.length === 0) throw projectionError("one operation exceeds projection request byte budget");
				break;
			}
			ops.push(op);
		}
		if (ops.length === 0 && compareCanonicalDecimals(projected, target) < 0) {
			throw projectionError("unprojected log gap");
		}
		this.renewProjectionLease(leaseToken, now);
		return {
			protocol_version: 1,
			epoch,
			from_seq_exclusive: projected,
			through_seq: ops.length > 0 ? ops[ops.length - 1].seq : projected,
			target_seq: target,
			ops,
		};
	}

	heartbeatProjectionLease(leaseToken: string, now = Date.now()): ProjectionState {
		this.assertLease(leaseToken, now);
		this.renewProjectionLease(leaseToken, now);
		return this.getProjectionState();
	}

	advanceProjectionCheckpoint(
		leaseToken: string,
		epoch: string,
		fromSeqExclusive: string,
		throughSeq: string,
		now = Date.now(),
	): ProjectionState {
		this.ctx.storage.transactionSync(() => {
			// Token check and checkpoint compare-and-set are fenced in the same
			// synchronous transaction. A timed-out predecessor can never replay
			// after a successor has acquired a fresh token.
			this.assertLease(leaseToken, now);
			if (epoch !== this.meta("epoch")) throw projectionError("epoch mismatch");
			const expected = assertCanonicalDecimal(fromSeqExclusive);
			const through = assertCanonicalDecimal(throughSeq);
			const current = this.projectedSeq();
			if (current !== expected) throw projectionError("checkpoint compare-and-set mismatch");
			if (compareCanonicalDecimals(through, current) < 0 || compareCanonicalDecimals(through, this.headSeq()) > 0) {
				throw projectionError("invalid projected through_seq");
			}
			this.setMeta("projected_seq", through);
			this.setMeta("projection_lease_expires_at", this.leaseExpiry(this.leaseNow(now)));
		});
		return this.getProjectionState();
	}

	releaseProjectionLease(leaseToken: string): void {
		if (this.metaOptional("projection_lease_token") !== leaseToken) return;
		this.ctx.storage.transactionSync(() => {
			this.deleteMeta("projection_lease_token");
			this.deleteMeta("projection_lease_expires_at");
		});
	}

	getProjectionState(): ProjectionState {
		return {
			protocol_version: 1,
			epoch: this.meta("epoch"),
			head_seq: this.headSeq(),
			projected_seq: this.projectedSeq(),
		};
	}

	private assertLease(token: string, now: number): void {
		if (typeof token !== "string" || token.length === 0 || this.metaOptional("projection_lease_token") !== token) {
			throw projectionError("projection lease is not held");
		}
		const expires = this.metaOptional("projection_lease_expires_at");
		if (!expires || compareCanonicalDecimals(expires, this.leaseNow(now)) <= 0) {
			throw projectionError("projection lease expired");
		}
	}

	private renewProjectionLease(token: string, now: number): void {
		this.ctx.storage.transactionSync(() => {
			this.assertLease(token, now);
			this.setMeta("projection_lease_expires_at", this.leaseExpiry(this.leaseNow(now)));
		});
	}

	private leaseNow(now: number): string {
		if (!Number.isSafeInteger(now) || now < 0) throw projectionError("lease clock must be a safe millisecond integer");
		return String(now);
	}

	private leaseExpiry(now: string): string {
		return (BigInt(assertCanonicalDecimal(now)) + BigInt(PROJECTION_LEASE_MS)).toString(10);
	}

	// ---------------------------------------------------------------------
	// Launch safety: physical log compaction is intentionally disabled.
	// ---------------------------------------------------------------------

	async alarm(): Promise<void> {
		// A cursor-0 device has no snapshot/reset bootstrap yet, so every
		// canonical operation remains replayable. Keep the alarm surface for
		// deployed-object compatibility, but deliberately delete zero rows.
		await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
	}

	private headSeq(): string { return this.meta("head_seq"); }
	private projectedSeq(): string { return this.meta("projected_seq"); }

	private meta(key: string): string {
		const row = this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key).toArray()[0];
		if (!row) throw new Error(`sync-hub invariant: missing meta ${key}`);
		return row.v;
	}

	private metaOptional(key: string): string | null {
		return this.ctx.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key).toArray()[0]?.v ?? null;
	}

	private setMeta(key: string, value: string): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
			key,
			value,
		);
	}

	private deleteMeta(key: string): void {
		this.ctx.storage.sql.exec("DELETE FROM meta WHERE k = ?", key);
	}
}
