/** Exact Hub -> Pro projection request wire format. */
export const PROJECTION_PROTOCOL_VERSION = 1 as const;
export const PROJECTION_PAGE_MAX_OPS = 100;
export const PROJECTION_PAGE_MAX_BYTES = 4_000_000;
export const PROJECTION_FETCH_TIMEOUT_MS = 45_000;

export interface ProjectionWireOp {
	seq: string;
	body: string;
	operation_sha256: string;
}

export interface ProjectionRequestInput {
	userId: string;
	epoch: string;
	fromSeqExclusive: string;
	throughSeq: string;
	ops: readonly ProjectionWireOp[];
}

const encoder = new TextEncoder();

/**
 * Serialize the complete request envelope in its stable field order. Both the
 * Durable Object page builder and the stateless Worker call this function, so
 * the 4,000,000-byte decision includes envelope fields, brackets, and commas.
 */
export function serializeProjectionRequest(input: ProjectionRequestInput): string {
	return JSON.stringify({
		protocol_version: PROJECTION_PROTOCOL_VERSION,
		user_id: input.userId,
		epoch: input.epoch,
		from_seq_exclusive: input.fromSeqExclusive,
		through_seq: input.throughSeq,
		ops: input.ops.map((op) => ({
			seq: op.seq,
			body: op.body,
			operation_sha256: op.operation_sha256,
		})),
	});
}

export function projectionRequestBytes(input: ProjectionRequestInput): number {
	return encoder.encode(serializeProjectionRequest(input)).length;
}

/**
 * Exact projectionRequestBytes while growing a page one op at a time, without
 * re-serializing the prefix (the old per-op re-serialization was O(n²) on the
 * event loop). JSON arrays have no whitespace, so the full request is the
 * empty-ops envelope plus each op's JSON plus one comma between ops.
 */
export class ProjectionPageByteCounter {
	private opsBytes = 0;
	private opCount = 0;

	constructor(private readonly envelope: Omit<ProjectionRequestInput, "ops" | "throughSeq">) {}

	/** Count `op` as the page's next op; returns the page's request bytes through it. */
	add(op: ProjectionWireOp): number {
		this.opsBytes += (this.opCount > 0 ? 1 : 0) + projectionOpBytes(op);
		this.opCount++;
		return projectionRequestBytes({ ...this.envelope, throughSeq: op.seq, ops: [] }) + this.opsBytes;
	}
}

function projectionOpBytes(op: ProjectionWireOp): number {
	return encoder.encode(JSON.stringify({
		seq: op.seq,
		body: op.body,
		operation_sha256: op.operation_sha256,
	})).length;
}
