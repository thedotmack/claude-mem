/**
 * Per-user ordered sync log. Port of workers/sync-hub/src/do/SyncHub.ts
 * onto Postgres: one transaction + advisory lock replaces DO single-threading.
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
	projectionRequestBytes,
} from "./projection-protocol";
import type { SocketRegistry } from "./sockets";

const MAX_PAGE = 500;
const ADVANCE_MAX_OPS = 100;
const ADVANCE_MAX_FRAME_BYTES = 262_144;
export const MAX_DEVICES_PER_USER = 64;
export const DEVICE_LIMIT_ERROR = "device_limit_exceeded";
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

export type StatusOutcome = StatusResult | HubRefusal;

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
	deleted: number;
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

type Tx = postgres.TransactionSql;

export class HubStore {
	constructor(
		private readonly sql: postgres.Sql,
		private readonly sockets: SocketRegistry,
	) {}

	private async withUserLock<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
		return this.sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
			await this.ensureUser(tx, userId);
			return fn(tx);
		});
	}

	private async ensureUser(tx: Tx, userId: string): Promise<void> {
		const epoch = newEpoch();
		await tx`
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

	async acceptWebSocket(userId: string, deviceId: string, deviceName: string | null): Promise<HubRefusal | { ok: true }> {
		try {
			await this.withUserLock(userId, async (tx) => {
				this.assertDeviceId(deviceId);
				await this.touchDevice(tx, userId, deviceId, normalizeDeviceName(deviceName));
			});
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
				let head = user.head_seq;
				for (const row of rows) {
					const body = row.body;
					const heads = await tx<HeadRow[]>`
						SELECT entity_rev, operation_sha256, deleted, seq
						FROM sync_entity_heads
						WHERE user_id = ${userId} AND entity_id = ${body.id}
					`;
					const existing = heads[0];
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
					await tx`
						INSERT INTO sync_ops
						 (user_id, seq, entity_id, kind, origin_device_id, origin_local_id, entity_rev,
						  operation_sha256, body, deleted, server_ts)
						 VALUES (
						  ${userId}, ${seq}, ${body.id}, ${body.kind}, ${body.origin_device_id},
						  ${body.origin_local_id}, ${body.entity_rev}, ${row.operationSha256},
						  ${row.serialized}, ${body.deleted ? 1 : 0}, ${nowDecimal}
						 )
					`;
					await tx`
						INSERT INTO sync_entity_heads
						 (user_id, entity_id, kind, origin_device_id, origin_local_id, entity_rev,
						  operation_sha256, deleted, seq)
						 VALUES (
						  ${userId}, ${body.id}, ${body.kind}, ${body.origin_device_id},
						  ${body.origin_local_id}, ${body.entity_rev}, ${row.operationSha256},
						  ${body.deleted ? 1 : 0}, ${seq}
						 )
						 ON CONFLICT (user_id, entity_id) DO UPDATE SET
						  kind = EXCLUDED.kind,
						  origin_device_id = EXCLUDED.origin_device_id,
						  origin_local_id = EXCLUDED.origin_local_id,
						  entity_rev = EXCLUDED.entity_rev,
						  operation_sha256 = EXCLUDED.operation_sha256,
						  deleted = EXCLUDED.deleted,
						  seq = EXCLUDED.seq
					`;
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
				if (head !== user.head_seq) {
					await tx`
						UPDATE sync_users
						SET head_seq = ${head}, updated_at = now()
						WHERE user_id = ${userId}
					`;
				}
			});
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

	async getChanges(
		userId: string,
		deviceId: string,
		sinceSeq: string,
		limit = MAX_PAGE,
		deviceName: string | null = null,
	): Promise<ChangesOutcome> {
		if (typeof deviceId !== "string" || deviceId.length === 0) throw invalid("deviceId must be non-empty");
		const since = assertCanonicalDecimal(sinceSeq);
		const lim = Number.isFinite(limit) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(limit))) : MAX_PAGE;
		try {
			return await this.withUserLock(userId, async (tx) => {
				const user = await this.loadUser(tx, userId);
				const head = user.head_seq;
				const acknowledged = decimalMin(since, head);
				await this.touchDevice(tx, userId, deviceId, normalizeDeviceName(deviceName));
				const existing = await tx<{ last_ack_seq: string }[]>`
					SELECT last_ack_seq FROM sync_devices
					WHERE user_id = ${userId} AND device_id = ${deviceId.trim()}
				`;
				const currentAck = existing[0]?.last_ack_seq ?? "0";
				const nextAck = compareCanonicalDecimals(currentAck, acknowledged) > 0 ? currentAck : acknowledged;
				await tx`
					UPDATE sync_devices SET last_ack_seq = ${nextAck}
					WHERE user_id = ${userId} AND device_id = ${deviceId.trim()}
				`;
				const rows = await tx<ChangeOp[]>`
					SELECT seq, body, operation_sha256, server_ts
					FROM sync_ops
					WHERE user_id = ${userId}
					  AND (length(seq) > length(${since}) OR (length(seq) = length(${since}) AND seq > ${since}))
					ORDER BY length(seq), seq
					LIMIT ${lim + 1}
				`;
				const more = rows.length > lim;
				const page = more ? rows.slice(0, lim) : rows;
				return {
					protocol_version: 2 as const,
					epoch: user.epoch,
					ops: page.map(toChange),
					head_seq: head,
					more,
				};
			});
		} catch (error) {
			if (isDeviceLimitError(error)) return { refused: true, error: DEVICE_LIMIT_ERROR };
			throw error;
		}
	}

	async getStatus(
		userId: string,
		deviceId: string | null = null,
		deviceName: string | null = null,
	): Promise<StatusOutcome> {
		try {
			return await this.withUserLock(userId, async (tx) => {
				if (deviceId !== null) {
					await this.touchExistingDevice(tx, userId, deviceId, normalizeDeviceName(deviceName));
				}
				const user = await this.loadUser(tx, userId);
				const counts = await tx<{ n: number }[]>`
					SELECT COUNT(*)::int AS n FROM sync_devices WHERE user_id = ${userId}
				`;
				return {
					protocol_version: 2 as const,
					epoch: user.epoch,
					head_seq: user.head_seq,
					projected_seq: user.projected_seq,
					op_count: Number(user.head_seq),
					device_count: counts[0]?.n ?? 0,
				};
			});
		} catch (error) {
			if (isDeviceLimitError(error)) return { refused: true, error: DEVICE_LIMIT_ERROR };
			throw error;
		}
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
				  AND (length(seq) > length(${projected}) OR (length(seq) = length(${projected}) AND seq > ${projected}))
				  AND (length(seq) < length(${target}) OR (length(seq) = length(${target}) AND seq <= ${target}))
				ORDER BY length(seq), seq
				LIMIT ${limit}
			`;
			const ops: ChangeOp[] = [];
			for (const row of rows) {
				const op = toChange(row);
				const candidate = [...ops, op];
				const bytes = projectionRequestBytes({
					userId: projectionUserId,
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

	async getProjectionState(userId: string): Promise<ProjectionState> {
		return this.withUserLock(userId, async (tx) => {
			return this.projectionStateFrom(await this.loadUser(tx, userId));
		});
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
		tx: Tx,
		userId: string,
		deviceId: string,
		name: string | null,
		now = Date.now(),
	): Promise<void> {
		const normalizedId = this.normalizeDeviceId(deviceId);
		await tx`
			UPDATE sync_devices
			SET name = COALESCE(name, ${name}), last_seen = ${now}
			WHERE user_id = ${userId} AND device_id = ${normalizedId}
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
