import type { ProjectionWireOp } from "./projection-protocol";

export const OPERATION_PAGE_PROTOCOL_VERSION = 1 as const;
export const OPERATION_PAGE_MAX_OPS = 100;
export const OPERATION_PAGE_MAX_BYTES = 4_000_000;

export type OperationPageWireOp = ProjectionWireOp;

export interface OperationPage {
	protocol_version: typeof OPERATION_PAGE_PROTOCOL_VERSION;
	user_id: string;
	epoch: string;
	after_seq: string;
	through_seq: string;
	head_seq: string;
	has_more: boolean;
	ops: OperationPageWireOp[];
}

export interface OperationPageRefusal {
	refused: true;
	error: string;
}

export type OperationPageOutcome = OperationPage | OperationPageRefusal;

const encoder = new TextEncoder();

export function operationPageWireOp(op: OperationPageWireOp): OperationPageWireOp {
	return {
		seq: op.seq,
		body: op.body,
		operation_sha256: op.operation_sha256,
	};
}

/** Stable field order shared by the DO byte guard and the Worker response. */
export function serializeOperationPage(page: OperationPage): string {
	return JSON.stringify({
		protocol_version: page.protocol_version,
		user_id: page.user_id,
		epoch: page.epoch,
		after_seq: page.after_seq,
		through_seq: page.through_seq,
		head_seq: page.head_seq,
		has_more: page.has_more,
		ops: page.ops.map((op) => ({
			seq: op.seq,
			body: op.body,
			operation_sha256: op.operation_sha256,
		})),
	});
}

export function operationPageBytes(page: OperationPage): number {
	return encoder.encode(serializeOperationPage(page)).length;
}

export const OPERATIONAL_HEALTH_PROTOCOL_VERSION = 1 as const;
export const OPERATIONAL_HEALTH_MIN_WINDOW_SECONDS = 60;
export const OPERATIONAL_HEALTH_MAX_WINDOW_SECONDS = 86_400;

export const REJECTED_OPERATION_CODES = [
	"device_limit_exceeded",
	"invalid_device_id",
	"invalid_json",
	"invalid_operation",
	"invalid_ops_shape",
	"origin_device_mismatch",
	"request_too_large",
	"revision_hash_conflict",
	"stale_revision",
	"too_many_ops",
	"unsupported_protocol",
] as const;

export const PROJECTION_FAILURE_CODES = [
	"busy",
	"internal_error",
	"not_configured",
	"page_empty",
	"page_too_large",
	"response_mismatch",
	"response_not_json",
	"upstream_conflict",
	"upstream_http_error",
	"upstream_timeout",
	"upstream_unreachable",
] as const;

export type RejectedOperationCode = typeof REJECTED_OPERATION_CODES[number];
export type ProjectionFailureCode = typeof PROJECTION_FAILURE_CODES[number];
export type OperationalEventKind = "rejected_operation" | "projection_failure";
export type OperationalEventCode = RejectedOperationCode | ProjectionFailureCode;

export interface OperationalEventAggregate {
	total: string;
	last_at: string | null;
	by_code: Array<{ code: string; count: string }>;
}

export interface OperationalHealth {
	protocol_version: typeof OPERATIONAL_HEALTH_PROTOCOL_VERSION;
	user_id: string;
	generated_at: string;
	window_seconds: number;
	epoch: string;
	head_seq: string;
	projected_seq: string;
	projection_lag_ops: string;
	rejected_operations: OperationalEventAggregate;
	projection_failures: OperationalEventAggregate;
}

const rejectedCodes = new Set<string>(REJECTED_OPERATION_CODES);
const projectionCodes = new Set<string>(PROJECTION_FAILURE_CODES);

export function isOperationalEventCode(
	kind: OperationalEventKind,
	code: string,
): code is OperationalEventCode {
	return kind === "rejected_operation" ? rejectedCodes.has(code) : projectionCodes.has(code);
}
