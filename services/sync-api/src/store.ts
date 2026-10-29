/**
 * Per-user ordered sync log. Port of workers/sync-hub/src/do/SyncHub.ts
 * onto Postgres: one transaction + advisory lock replaces DO single-threading.
 *
 * Writers (push, projection lease/checkpoint, reset, rename, socket accept)
 * take a per-user turn: an in-process FIFO first (waiting holds no pool
 * connection), then the advisory lock inside a short transaction. Pulls and
 * status reads take no per-user lock: they read one consistent snapshot and
 * record the device cursor with a single-row UPDATE.
 *
 * Seq is canonical decimal TEXT ordered by (length(seq), seq). Range filters
 * must be written as row comparisons on that pair so the btree
 * (user_id, length(seq), seq) can seek to them; the equivalent OR form is only
 * a post-fetch filter and walks the user's whole log (12.7s at seq 73,000 on
 * Neon, versus 2.7ms as a row comparison).
 */
import type postgres from "postgres";
import {
	assertCanonicalDecimal,
	compareCanonicalDecimals,
	decimalMin,
	incrementCanonicalDecimal,
	newEpoch,
	parseCanonicalOperation,
	type CanonicalContentBody,
	type CanonicalKind,
	type CanonicalWireOp,
} from "./canonical-content";
import {
	PROJECTION_PAGE_MAX_BYTES,
	PROJECTION_PAGE_MAX_OPS,
	ProjectionPageByteCounter,
} from "./projection-protocol";
import type { SocketRegistry } from "./sockets";
import { CLIENT_CLOSED_REQUEST_ERROR, UserQueue } from "./user-queue";

const MAX_PAGE = 500;
const ADVANCE_MAX_OPS = 100;
const ADVANCE_MAX_FRAME_BYTES = 262_144;
export const MAX_DEVICES_PER_USER = 64;
export const DEVICE_LIMIT_ERROR = "device_limit_exceeded";
export const PROJECTION_LEASE_MS = 90_000;
/** Longest a request waits in-process for earlier same-user work before a retryable 503. */
export const DEFAULT_USER_TURN_MAX_WAIT_MS = 15_000;
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

export interface HubRefusal {
	refused: true;
	error: string;
}

export type PushOutcome = PushResult | HubRefusal;

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

export type ChangesOutcome = ChangesResult | HubRefusal;

export interface StatusResult {
	protocol_version: 2;
	epoch: string;
	head_seq: string;
	projected_seq: string;
	op_count: number;
	device_count: number;
}

export interface DeviceMetadata {
	device_id: string;
	name: string | null;
	last_seen_at: string | null;
	last_seen_epoch_ms: string | null;
	last_ack_seq: string;
	cursor_lag_ops: string;
	connection_state: "connected" | "disconnected";
}

export interface HubMetadata {
	protocol_version: 1;
	user_id: string;
	epoch: string;
	head_seq: string;
	projected_seq: string;
	projection_lag_ops: string;
	sync_health: "healthy" | "projector_lagging";
	devices: DeviceMetadata[];
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

export interface ResetResult {
	protocol_version: 1;
	epoch: string;
	head_seq: string;
}

export const INVALID_OPS_PREFIX = "invalid_ops:";
export const PROJECTION_ERROR_PREFIX = "projection_error:";

function invalid(message: string): Error {
	return new Error(`${INVALID_OPS_PREFIX} ${message}`);
}

function projectionError(message: string): Error {
	return new Error(`${PROJECTION_ERROR_PREFIX} ${message}`);
}

function deviceLimitError(): Error {
	return new Error(DEVICE_LIMIT_ERROR);
}

function isDeviceLimitError(error: unknown): boolean {
	return error instanceof Error && error.message === DEVICE_LIMIT_ERROR;
}

interface ValidatedOp {
	body: CanonicalContentBody;
	serialized: string;
	operationSha256: string;
}

interface HeadRow {
	entity_rev: string;
	operation_sha256: string;
	seq: string;
}

/** An op a push appends to the log (and, if it is the entity's last op in the batch, its new head). */
interface InsertedOp {
	body: CanonicalContentBody;
	serialized: string;
	operationSha256: string;
	seq: string;
}

interface UserRow {
	epoch: string;
	head_seq: string;
	projected_seq: string;
	projection_lease_token: string | null;
	projection_lease_expires_at: string | null;
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

function changesPage(epoch: string, headSeq: string, rows: ChangeOp[], limit: number): ChangesResult {
	const more = rows.length > limit;
	const page = more ? rows.slice(0, limit) : rows;
	return {
		protocol_version: 2 as const,
		epoch,
		ops: page.map(toChange),
		head_seq: headSeq,
		more,
	};
}

type Tx = postgres.TransactionSql;
/** A query target that is either the pool or an open transaction. */
type Db = postgres.ISql;

export class HubStore {
	private readonly userQueue = new UserQueue();

	constructor(
		private readonly sql: postgres.Sql,
		private readonly sockets: SocketRegistry,
		private readonly userTurnMaxWaitMs = DEFAULT_USER_TURN_MAX_WAIT_MS,
	) {}

	/**
	 * Serialized per-user write transaction. Waiting for the user's turn
	 * happens in-process (no pool connection held); the advisory lock is then
	 * normally free and guards against other processes. Rejects with
	 * SYNC_HUB_BUSY_ERROR after userTurnMaxWaitMs, or CLIENT_CLOSED_REQUEST_ERROR
	 * when `signal` aborts before the turn starts.
	 *
	 * `fn` must only await queries on `tx`. Never await HTTP or other slow work
	 * inside it: that holds the user's lock, and if
	 * idle_in_transaction_session_timeout ends the session meanwhile, the next
	 * `tx` query makes postgres.js write to the closed socket and crash the process.
	 */
	private async withUserLock<T>(
		userId: string,
		fn: (tx: Tx) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		return this.userQueue.run(userId, { maxWaitMs: this.userTurnMaxWaitMs, signal }, () =>
			this.sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
				await this.ensureUser(tx, userId);
				return fn(tx);
			}));
	}

	private async ensureUser(db: Db, userId: string): Promise<void> {
		const epoch = newEpoch();
		await db`
			INSERT INTO sync_users (user_id, epoch, head_seq, projected_seq)
			VALUES (${userId}, ${epoch}, '0', '0')
			ON CONFLICT (user_id) DO NOTHING
		`;
	}

	private async loadUser(tx: Tx, userId: string): Promise<UserRow> {
		const rows = await tx<UserRow[]>`
			SELECT epoch, head_seq, projected_seq, projection_lease_token, projection_lease_expires_at
			FROM sync_users
			WHERE user_id = ${userId}
			FOR UPDATE
		`;
		const row = rows[0];
		if (!row) throw new Error(`sync-hub invariant: missing user ${userId}`);
		return row;
	}

	async resetAllState(userId: string): Promise<ResetResult> {
		this.sockets.closeUser(userId, "sync-hub reset");
		return this.withUserLock(userId, async (tx) => {
			// Deleting a whole log (600k ops for the largest user) legitimately
			// outlasts the pool's statement_timeout; reset is a deliberate admin
			// action, so it alone may hold the user's turn that long.
			await tx`SET LOCAL statement_timeout = 0`;
			await tx`DELETE FROM sync_ops WHERE user_id = ${userId}`;
			await tx`DELETE FROM sync_entity_heads WHERE user_id = ${userId}`;
			await tx`DELETE FROM sync_devices WHERE user_id = ${userId}`;
			const epoch = newEpoch();
			await tx`
				UPDATE sync_users
				SET epoch = ${epoch},
				    head_seq = '0',
				    projected_seq = '0',
				    projection_lease_token = NULL,
				    projection_lease_expires_at = NULL,
				    updated_at = now()
				WHERE user_id = ${userId}
			`;
			return { protocol_version: 1 as const, epoch, head_seq: "0" };
		});
	}

	async acceptWebSocket(
		userId: string,
		deviceId: string,
		deviceName: string | null,
		signal?: AbortSignal,
	): Promise<HubRefusal | { ok: true }> {
		try {
			await this.withUserLock(userId, async (tx) => {
				this.assertDeviceId(deviceId);
				await this.touchDevice(tx, userId, deviceId, normalizeDeviceName(deviceName));
			}, signal);
			return { ok: true };
		} catch (error) {
			if (isDeviceLimitError(error)) return { refused: true, error: DEVICE_LIMIT_ERROR };
			if (error instanceof Error && error.message.startsWith(INVALID_OPS_PREFIX)) {
				return { refused: true, error: error.message };
			}
			throw error;
		}
	}

	fanOutCommitted(
		userId: string,
		originDeviceId: string,
		headBefore: string,
		epoch: string,
		head: string,
		ops: ChangeOp[],
	): void {
		try {
			const sockets = this.sockets.forUser(userId);
			if (sockets.length === 0) return;
			if (ops.length === 0) return;
			let frame: string;
			const bodyLen = ops.reduce((sum, op) => sum + encoder.encode(op.body).length, 0);
			if (ops.length > ADVANCE_MAX_OPS || bodyLen > ADVANCE_MAX_FRAME_BYTES) {
				frame = JSON.stringify({ type: "advance", epoch, head_seq: head });
			} else {
				frame = JSON.stringify({ type: "op", epoch, ops });
				if (encoder.encode(frame).length > ADVANCE_MAX_FRAME_BYTES) {
					frame = JSON.stringify({ type: "advance", epoch, head_seq: head });
				}
			}
			for (const socket of sockets) {
				if (socket.deviceId === originDeviceId) continue;
				try { socket.send(frame); } catch { /* drop */ }
			}
		} catch (error) {
			console.error("sync-hub fan-out failed (advisory; push unaffected):", error);
		}
	}

	async pushOps(
		userId: string,
		deviceId: string,
		ops: PushOp[],
		deviceName: string | null = null,
		signal?: AbortSignal,
	): Promise<PushOutcome> {
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
			if (isDeviceLimitError(error)) return { refused: true, error: DEVICE_LIMIT_ERROR };
			throw error;
		}

		const now = Date.now();
		const nowDecimal = String(now);
		let headBefore = "0";
		let headAfter = "0";
		let epoch = "0";
		const newOps: ChangeOp[] = [];
		const acked: AckedOp[] = [];
		try {
			await this.withUserLock(userId, async (tx) => {
				await this.touchDevice(tx, userId, deviceId, normalizeDeviceName(deviceName), now);
				const user = await this.loadUser(tx, userId);
				headBefore = user.head_seq;
				epoch = user.epoch;
				// One lookup and three set-based writes per push, instead of three
				// round trips per op while holding the user's lock. The loop below
				// keeps the old per-op semantics: each op sees the heads written by
				// earlier ops in the same batch, and any refusal rolls back all of it.
				const heads = await this.loadEntityHeads(tx, userId, rows);
				const inserted: InsertedOp[] = [];
				const finalHeads = new Map<string, InsertedOp>();
				let head = user.head_seq;
				for (const row of rows) {
					const body = row.body;
					const existing = heads.get(body.id);
					if (existing) {
						const order = compareCanonicalDecimals(body.entity_rev, existing.entity_rev);
						if (order < 0) throw invalid(`stale_revision:${body.id}:${body.entity_rev}<${existing.entity_rev}`);
						if (order === 0) {
							if (row.operationSha256 !== existing.operation_sha256) {
								throw invalid(`revision_hash_conflict:${body.id}:${body.entity_rev}`);
							}
							acked.push({
								id: body.id,
								kind: body.kind,
								origin_local_id: body.origin_local_id,
								entity_rev: body.entity_rev,
								operation_sha256: existing.operation_sha256,
								seq: String(existing.seq),
							});
							continue;
						}
					}

					const seq = incrementCanonicalDecimal(head);
					const op: InsertedOp = { body, serialized: row.serialized, operationSha256: row.operationSha256, seq };
					inserted.push(op);
					finalHeads.set(body.id, op);
					heads.set(body.id, { entity_rev: body.entity_rev, operation_sha256: row.operationSha256, seq });
					head = seq;
					newOps.push({
						seq,
						body: row.serialized,
						operation_sha256: row.operationSha256,
						server_ts: nowDecimal,
					});
					acked.push({
						id: body.id,
						kind: body.kind,
						origin_local_id: body.origin_local_id,
						entity_rev: body.entity_rev,
						operation_sha256: row.operationSha256,
						seq,
					});
				}
				headAfter = head;
				if (inserted.length > 0) {
					await this.insertOps(tx, userId, inserted, nowDecimal);
					await this.upsertEntityHeads(tx, userId, [...finalHeads.values()]);
					await tx`
						UPDATE sync_users
						SET head_seq = ${head}, updated_at = now()
						WHERE user_id = ${userId}
					`;
				}
			}, signal);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(INVALID_OPS_PREFIX)) {
				return { refused: true, error: error.message };
			}
			if (isDeviceLimitError(error)) return { refused: true, error: DEVICE_LIMIT_ERROR };
			throw error;
		}

		this.fanOutCommitted(userId, deviceId, headBefore, epoch, headAfter, newOps);
		return { acked, head_seq: headAfter };
	}

	/**
	 * Pull one page. Lock-free on the hot path: the page and head come from one
	 * REPEATABLE READ snapshot (never a mix of epochs or a page past head), and
	 * the device cursor is a single-row UPDATE guarded by that snapshot's epoch.
	 * Only a device's first pull (64-device cap), a user's first contact, or a
	 * reset racing the cursor write takes the per-user lock.
	 */
	async getChanges(
		userId: string,
		deviceId: string,
		sinceSeq: string,
		limit = MAX_PAGE,
		deviceName: string | null = null,
		signal?: AbortSignal,
	): Promise<ChangesOutcome> {
		if (typeof deviceId !== "string" || deviceId.length === 0) throw invalid("deviceId must be non-empty");
		const since = assertCanonicalDecimal(sinceSeq);
		const lim = Number.isFinite(limit) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(limit))) : MAX_PAGE;
		const normalizedId = this.normalizeDeviceId(deviceId);
		const name = normalizeDeviceName(deviceName);
		throwIfClientClosed(signal);
		const snapshot = await this.sql.begin("isolation level repeatable read read only", async (tx) => {
			const users = await tx<{ epoch: string; head_seq: string }[]>`
				SELECT epoch, head_seq FROM sync_users WHERE user_id = ${userId}
			`;
			const user = users[0];
			if (!user) return null;
			return { user, rows: await this.selectChangesPage(tx, userId, since, lim) };
		});
		if (snapshot !== null) {
			const acknowledged = decimalMin(since, snapshot.user.head_seq);
			if (await this.advanceDeviceCursor(this.sql, userId, normalizedId, name, acknowledged, snapshot.user.epoch)) {
				return changesPage(snapshot.user.epoch, snapshot.user.head_seq, snapshot.rows, lim);
			}
		}
		try {
			return await this.withUserLock(userId, async (tx) => {
				const user = await this.loadUser(tx, userId);
				await this.touchDevice(tx, userId, normalizedId, name);
				const acknowledged = decimalMin(since, user.head_seq);
				await this.advanceDeviceCursor(tx, userId, normalizedId, name, acknowledged, user.epoch);
				const rows = await this.selectChangesPage(tx, userId, since, lim);
				return changesPage(user.epoch, user.head_seq, rows, lim);
			}, signal);
		} catch (error) {
			if (isDeviceLimitError(error)) return { refused: true, error: DEVICE_LIMIT_ERROR };
			throw error;
		}
	}

	private async selectChangesPage(db: Db, userId: string, since: string, limit: number): Promise<ChangeOp[]> {
		return db<ChangeOp[]>`
			SELECT seq, body, operation_sha256, server_ts
			FROM sync_ops
			WHERE user_id = ${userId}
			  AND (length(seq), seq) > (length(${since}), ${since})
			ORDER BY length(seq), seq
			LIMIT ${limit + 1}
		`;
	}

	/**
	 * Touch a registered device and raise its cursor monotonically, only if the
	 * user is still on `epoch`. False when the device is not registered or a
	 * reset changed the epoch; the caller then takes the locked path.
	 */
	private async advanceDeviceCursor(
		db: Db,
		userId: string,
		deviceId: string,
		name: string | null,
		acknowledged: string,
		epoch: string,
		now = Date.now(),
	): Promise<boolean> {
		const result = await db`
			UPDATE sync_devices AS d
			SET last_seen = ${now},
			    name = COALESCE(d.name, ${name}),
			    last_ack_seq = CASE
			      WHEN (length(d.last_ack_seq), d.last_ack_seq) >= (length(${acknowledged}), ${acknowledged})
			        THEN d.last_ack_seq
			      ELSE ${acknowledged}
			    END
			FROM sync_users AS u
			WHERE d.user_id = ${userId} AND d.device_id = ${deviceId}
			  AND u.user_id = d.user_id AND u.epoch = ${epoch}
		`;
		return result.count > 0;
	}

	/** Lock-free: one statement reads a consistent row; first contact creates the user. */
	async getStatus(
		userId: string,
		deviceId: string | null = null,
		deviceName: string | null = null,
		signal?: AbortSignal,
	): Promise<StatusResult> {
		throwIfClientClosed(signal);
		if (deviceId !== null) {
			await this.touchExistingDevice(this.sql, userId, deviceId, normalizeDeviceName(deviceName));
		}
		const readStatus = async () => (await this.sql<{
			epoch: string;
			head_seq: string;
			projected_seq: string;
			device_count: number;
		}[]>`
			SELECT u.epoch, u.head_seq, u.projected_seq,
			       (SELECT COUNT(*)::int FROM sync_devices AS d WHERE d.user_id = u.user_id) AS device_count
			FROM sync_users AS u
			WHERE u.user_id = ${userId}
		`)[0];
		let status = await readStatus();
		if (!status) {
			await this.ensureUser(this.sql, userId);
			status = await readStatus();
		}
		if (!status) throw new Error(`sync-hub invariant: missing user ${userId}`);
		return {
			protocol_version: 2 as const,
			epoch: status.epoch,
			head_seq: status.head_seq,
			projected_seq: status.projected_seq,
			op_count: Number(status.head_seq),
			device_count: status.device_count,
		};
	}

	async getMetadata(userId: string): Promise<HubMetadata> {
		if (typeof userId !== "string" || userId.length === 0) throw invalid("user_id must be non-empty");
		return this.withUserLock(userId, async (tx) => {
			const user = await this.loadUser(tx, userId);
			const connected = this.sockets.connectedDeviceIds(userId);
			const rows = await tx<{
				device_id: string;
				name: string | null;
				last_ack_seq: string;
				last_seen: string | number | null;
			}[]>`
				SELECT device_id, name, last_ack_seq, last_seen
				FROM sync_devices
				WHERE user_id = ${userId}
				ORDER BY last_seen IS NULL, last_seen DESC, device_id
				LIMIT ${MAX_DEVICES_PER_USER}
			`;
			const devices = rows.map((row) => {
				const lastSeen = row.last_seen === null || row.last_seen === undefined ? null : String(row.last_seen);
				return {
					device_id: row.device_id,
					name: row.name,
					last_seen_at: lastSeen === null ? null : new Date(Number(lastSeen)).toISOString(),
					last_seen_epoch_ms: lastSeen,
					last_ack_seq: row.last_ack_seq,
					cursor_lag_ops: decimalLag(user.head_seq, row.last_ack_seq),
					connection_state: connected.has(row.device_id) ? "connected" as const : "disconnected" as const,
				};
			});
			return {
				protocol_version: 1 as const,
				user_id: userId,
				epoch: user.epoch,
				head_seq: user.head_seq,
				projected_seq: user.projected_seq,
				projection_lag_ops: decimalLag(user.head_seq, user.projected_seq),
				sync_health: user.head_seq === user.projected_seq ? "healthy" : "projector_lagging",
				devices,
			};
		});
	}

	async renameDevice(userId: string, deviceId: string, name: string): Promise<boolean> {
		const normalizedId = deviceId.trim();
		const normalizedName = normalizeDeviceName(name);
		if (normalizedId.length === 0 || normalizedId.length > 128) throw invalid("device_id must be 1-128 characters");
		if (normalizedName === null) throw invalid("name must be 1-80 characters");
		return this.withUserLock(userId, async (tx) => {
			const result = await tx`
				UPDATE sync_devices SET name = ${normalizedName}
				WHERE user_id = ${userId} AND device_id = ${normalizedId}
			`;
			return result.count > 0;
		});
	}

	async acquireProjectionLease(userId: string, targetSeq: string, now = Date.now()): Promise<ProjectionLease> {
		const target = assertCanonicalDecimal(targetSeq);
		return this.withUserLock(userId, async (tx) => {
			const user = await this.loadUser(tx, userId);
			if (compareCanonicalDecimals(target, user.head_seq) > 0) throw projectionError("target_seq exceeds head_seq");
			const nowValue = this.leaseNow(now);
			if (
				user.projection_lease_token
				&& user.projection_lease_expires_at
				&& compareCanonicalDecimals(user.projection_lease_expires_at, nowValue) > 0
			) {
				return {
					acquired: false,
					epoch: user.epoch,
					head_seq: user.head_seq,
					projected_seq: user.projected_seq,
					target_seq: target,
				};
			}
			const token = crypto.randomUUID();
			await tx`
				UPDATE sync_users
				SET projection_lease_token = ${token},
				    projection_lease_expires_at = ${this.leaseExpiry(nowValue)},
				    updated_at = now()
				WHERE user_id = ${userId}
			`;
			return {
				acquired: true,
				lease_token: token,
				epoch: user.epoch,
				head_seq: user.head_seq,
				projected_seq: user.projected_seq,
				target_seq: target,
			};
		});
	}

	async getProjectionPage(
		userId: string,
		leaseToken: string,
		targetSeq: string,
		projectionUserId: string,
		maxOps = PROJECTION_PAGE_MAX_OPS,
		maxBytes = PROJECTION_PAGE_MAX_BYTES,
		now = Date.now(),
	): Promise<ProjectionPage> {
		if (typeof projectionUserId !== "string" || projectionUserId.length === 0) {
			throw projectionError("user_id must be non-empty");
		}
		const target = assertCanonicalDecimal(targetSeq);
		const limit = Math.min(PROJECTION_PAGE_MAX_OPS, Math.max(1, Math.floor(maxOps)));
		const byteLimit = Math.min(PROJECTION_PAGE_MAX_BYTES, Math.max(1, Math.floor(maxBytes)));
		return this.withUserLock(userId, async (tx) => {
			const user = await this.assertLease(tx, userId, leaseToken, now);
			if (compareCanonicalDecimals(target, user.head_seq) > 0) throw projectionError("target_seq exceeds head_seq");
			const projected = user.projected_seq;
			const epoch = user.epoch;
			const rows = await tx<ChangeOp[]>`
				SELECT seq, body, operation_sha256, server_ts
				FROM sync_ops
				WHERE user_id = ${userId}
				  AND (length(seq), seq) > (length(${projected}), ${projected})
				  AND (length(seq), seq) <= (length(${target}), ${target})
				ORDER BY length(seq), seq
				LIMIT ${limit}
			`;
			const ops: ChangeOp[] = [];
			const pageBytes = new ProjectionPageByteCounter({
				userId: projectionUserId,
				epoch,
				fromSeqExclusive: projected,
			});
			for (const row of rows) {
				const op = toChange(row);
				if (pageBytes.add(op) > byteLimit) {
					if (ops.length === 0) throw projectionError("one operation exceeds projection request byte budget");
					break;
				}
				ops.push(op);
			}
			if (ops.length === 0 && compareCanonicalDecimals(projected, target) < 0) {
				throw projectionError("unprojected log gap");
			}
			await this.renewProjectionLease(tx, userId, leaseToken, now);
			return {
				protocol_version: 1 as const,
				epoch,
				from_seq_exclusive: projected,
				through_seq: ops.length > 0 ? ops[ops.length - 1].seq : projected,
				target_seq: target,
				ops,
			};
		});
	}

	async heartbeatProjectionLease(userId: string, leaseToken: string, now = Date.now()): Promise<ProjectionState> {
		return this.withUserLock(userId, async (tx) => {
			await this.assertLease(tx, userId, leaseToken, now);
			await this.renewProjectionLease(tx, userId, leaseToken, now);
			return this.projectionStateFrom(await this.loadUser(tx, userId));
		});
	}

	async advanceProjectionCheckpoint(
		userId: string,
		leaseToken: string,
		epoch: string,
		fromSeqExclusive: string,
		throughSeq: string,
		now = Date.now(),
	): Promise<ProjectionState> {
		return this.withUserLock(userId, async (tx) => {
			const user = await this.assertLease(tx, userId, leaseToken, now);
			if (epoch !== user.epoch) throw projectionError("epoch mismatch");
			const expected = assertCanonicalDecimal(fromSeqExclusive);
			const through = assertCanonicalDecimal(throughSeq);
			const current = user.projected_seq;
			if (current !== expected) throw projectionError("checkpoint compare-and-set mismatch");
			if (compareCanonicalDecimals(through, current) < 0 || compareCanonicalDecimals(through, user.head_seq) > 0) {
				throw projectionError("invalid projected through_seq");
			}
			await tx`
				UPDATE sync_users
				SET projected_seq = ${through},
				    projection_lease_expires_at = ${this.leaseExpiry(this.leaseNow(now))},
				    updated_at = now()
				WHERE user_id = ${userId}
			`;
			return this.projectionStateFrom({ ...user, projected_seq: through });
		});
	}

	async releaseProjectionLease(userId: string, leaseToken: string): Promise<void> {
		await this.withUserLock(userId, async (tx) => {
			const user = await this.loadUser(tx, userId);
			if (user.projection_lease_token !== leaseToken) return;
			await tx`
				UPDATE sync_users
				SET projection_lease_token = NULL,
				    projection_lease_expires_at = NULL,
				    updated_at = now()
				WHERE user_id = ${userId}
			`;
		});
	}

	/** Lock-free read of the checkpoint; first contact creates the user. */
	async getProjectionState(userId: string): Promise<ProjectionState> {
		const readState = async () => (await this.sql<{ epoch: string; head_seq: string; projected_seq: string }[]>`
			SELECT epoch, head_seq, projected_seq FROM sync_users WHERE user_id = ${userId}
		`)[0];
		let state = await readState();
		if (!state) {
			await this.ensureUser(this.sql, userId);
			state = await readState();
		}
		if (!state) throw new Error(`sync-hub invariant: missing user ${userId}`);
		return { protocol_version: 1, epoch: state.epoch, head_seq: state.head_seq, projected_seq: state.projected_seq };
	}

	private projectionStateFrom(user: UserRow): ProjectionState {
		return {
			protocol_version: 1,
			epoch: user.epoch,
			head_seq: user.head_seq,
			projected_seq: user.projected_seq,
		};
	}

	private async assertLease(tx: Tx, userId: string, token: string, now: number): Promise<UserRow> {
		const user = await this.loadUser(tx, userId);
		if (typeof token !== "string" || token.length === 0 || user.projection_lease_token !== token) {
			throw projectionError("projection lease is not held");
		}
		if (!user.projection_lease_expires_at || compareCanonicalDecimals(user.projection_lease_expires_at, this.leaseNow(now)) <= 0) {
			throw projectionError("projection lease expired");
		}
		return user;
	}

	private async renewProjectionLease(tx: Tx, userId: string, token: string, now: number): Promise<void> {
		await this.assertLease(tx, userId, token, now);
		await tx`
			UPDATE sync_users
			SET projection_lease_expires_at = ${this.leaseExpiry(this.leaseNow(now))},
			    updated_at = now()
			WHERE user_id = ${userId}
		`;
	}

	private leaseNow(now: number): string {
		if (!Number.isSafeInteger(now) || now < 0) throw projectionError("lease clock must be a safe millisecond integer");
		return String(now);
	}

	private leaseExpiry(now: string): string {
		return (BigInt(assertCanonicalDecimal(now)) + BigInt(PROJECTION_LEASE_MS)).toString(10);
	}

	private async touchDevice(
		tx: Tx,
		userId: string,
		deviceId: string,
		name: string | null,
		now = Date.now(),
	): Promise<void> {
		const normalizedId = this.normalizeDeviceId(deviceId);
		const result = await tx`
			INSERT INTO sync_devices (user_id, device_id, name, last_seen)
			SELECT ${userId}, ${normalizedId}, ${name}, ${now}
			WHERE EXISTS (
				SELECT 1 FROM sync_devices WHERE user_id = ${userId} AND device_id = ${normalizedId}
			) OR (SELECT COUNT(*) FROM sync_devices WHERE user_id = ${userId}) < ${MAX_DEVICES_PER_USER}
			ON CONFLICT (user_id, device_id) DO UPDATE SET
			 name = COALESCE(sync_devices.name, EXCLUDED.name),
			 last_seen = EXCLUDED.last_seen
		`;
		if (result.count === 0) throw deviceLimitError();
	}

	private async touchExistingDevice(
		db: Db,
		userId: string,
		deviceId: string,
		name: string | null,
		now = Date.now(),
	): Promise<void> {
		const normalizedId = this.normalizeDeviceId(deviceId);
		await db`
			UPDATE sync_devices
			SET name = COALESCE(name, ${name}), last_seen = ${now}
			WHERE user_id = ${userId} AND device_id = ${normalizedId}
		`;
	}

	private async loadEntityHeads(tx: Tx, userId: string, rows: ValidatedOp[]): Promise<Map<string, HeadRow>> {
		const heads = new Map<string, HeadRow>();
		if (rows.length === 0) return heads;
		const entityIds = [...new Set(rows.map((row) => row.body.id))];
		const found = await tx<(HeadRow & { entity_id: string })[]>`
			SELECT entity_id, entity_rev, operation_sha256, seq
			FROM sync_entity_heads
			WHERE user_id = ${userId} AND entity_id = ANY(${entityIds}::text[])
		`;
		for (const head of found) heads.set(head.entity_id, head);
		return heads;
	}

	private async insertOps(tx: Tx, userId: string, ops: InsertedOp[], serverTs: string): Promise<void> {
		await tx`
			INSERT INTO sync_ops
			 (user_id, seq, entity_id, kind, origin_device_id, origin_local_id, entity_rev,
			  operation_sha256, body, deleted, server_ts)
			SELECT ${userId}, op.seq, op.entity_id, op.kind, op.origin_device_id, op.origin_local_id,
			       op.entity_rev, op.operation_sha256, op.body, op.deleted, ${serverTs}
			FROM unnest(
			  ${ops.map((op) => op.seq)}::text[],
			  ${ops.map((op) => op.body.id)}::text[],
			  ${ops.map((op) => op.body.kind)}::text[],
			  ${ops.map((op) => op.body.origin_device_id)}::text[],
			  ${ops.map((op) => op.body.origin_local_id)}::text[],
			  ${ops.map((op) => op.body.entity_rev)}::text[],
			  ${ops.map((op) => op.operationSha256)}::text[],
			  ${ops.map((op) => op.serialized)}::text[],
			  ${ops.map((op) => (op.body.deleted ? 1 : 0))}::int[]
			) AS op(seq, entity_id, kind, origin_device_id, origin_local_id, entity_rev,
			        operation_sha256, body, deleted)
		`;
	}

	/** `heads` holds each entity at most once (ON CONFLICT cannot touch a row twice). */
	private async upsertEntityHeads(tx: Tx, userId: string, heads: InsertedOp[]): Promise<void> {
		await tx`
			INSERT INTO sync_entity_heads
			 (user_id, entity_id, kind, origin_device_id, origin_local_id, entity_rev,
			  operation_sha256, deleted, seq)
			SELECT ${userId}, head.entity_id, head.kind, head.origin_device_id, head.origin_local_id,
			       head.entity_rev, head.operation_sha256, head.deleted, head.seq
			FROM unnest(
			  ${heads.map((head) => head.body.id)}::text[],
			  ${heads.map((head) => head.body.kind)}::text[],
			  ${heads.map((head) => head.body.origin_device_id)}::text[],
			  ${heads.map((head) => head.body.origin_local_id)}::text[],
			  ${heads.map((head) => head.body.entity_rev)}::text[],
			  ${heads.map((head) => head.operationSha256)}::text[],
			  ${heads.map((head) => (head.body.deleted ? 1 : 0))}::int[],
			  ${heads.map((head) => head.seq)}::text[]
			) AS head(entity_id, kind, origin_device_id, origin_local_id, entity_rev,
			          operation_sha256, deleted, seq)
			ON CONFLICT (user_id, entity_id) DO UPDATE SET
			 kind = EXCLUDED.kind,
			 origin_device_id = EXCLUDED.origin_device_id,
			 origin_local_id = EXCLUDED.origin_local_id,
			 entity_rev = EXCLUDED.entity_rev,
			 operation_sha256 = EXCLUDED.operation_sha256,
			 deleted = EXCLUDED.deleted,
			 seq = EXCLUDED.seq
		`;
	}

	private normalizeDeviceId(deviceId: string): string {
		const normalizedId = deviceId.trim();
		if (normalizedId.length === 0 || normalizedId.length > 128) {
			throw invalid("deviceId must be 1-128 characters");
		}
		return normalizedId;
	}

	private assertDeviceId(deviceId: string): string {
		return this.normalizeDeviceId(deviceId);
	}
}

function throwIfClientClosed(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error(CLIENT_CLOSED_REQUEST_ERROR);
}

function normalizeDeviceName(value: string | null): string | null {
	if (value === null) return null;
	const normalized = value.trim();
	if (normalized.length === 0) return null;
	if (normalized.length > 80) throw invalid("device name must be at most 80 characters");
	return normalized;
}

function decimalLag(head: string, cursor: string): string {
	const canonicalHead = assertCanonicalDecimal(head);
	const canonicalCursor = assertCanonicalDecimal(cursor);
	if (compareCanonicalDecimals(canonicalCursor, canonicalHead) >= 0) return "0";
	return (BigInt(canonicalHead) - BigInt(canonicalCursor)).toString(10);
}
