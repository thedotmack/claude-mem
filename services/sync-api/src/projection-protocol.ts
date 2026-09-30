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
