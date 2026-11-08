/**
 * Push-path projection drain. Port of services/sync-hub drainProjection.
 * Catch-up and checkpoint both finish inside the calling request.
 */
import {
	PROJECTION_FETCH_TIMEOUT_MS,
	PROJECTION_PAGE_MAX_BYTES,
	PROJECTION_PAGE_MAX_OPS,
	PROJECTION_PROTOCOL_VERSION,
	serializeProjectionRequest,
} from "./projection-protocol";
import { PROJECTION_LEASE_MS, type HubStore } from "./store";
import type { SyncApiEnv } from "./env";

const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const encoder = new TextEncoder();

export const POLL_PUSH_DRAIN_MAX_PAGES = 8;
export const REPAIR_DRAIN_MAX_PAGES = 1;

if (PROJECTION_FETCH_TIMEOUT_MS >= PROJECTION_LEASE_MS) {
	throw new Error("projection fetch timeout must be strictly shorter than the Hub lease");
}

interface DrainSuccess {
	ok: true;
	projectedSeq: string;
}

interface DrainFailure {
	ok: false;
	error: string;
	projectedSeq: string;
	httpStatus: 409 | 503;
	retryable: boolean;
	/**
	 * Whole seconds until the incumbent lease expires. Set for
	 * `projection_busy` only, the one failure whose wait the Hub knows.
	 */
	retryAfterSeconds?: number;
}

const PROJECTION_RETRY_AFTER_MAX_SECONDS = Math.ceil(PROJECTION_LEASE_MS / 1000);

/** Whole-second Retry-After for a busy lease, clamped to (0, the lease length]. */
function leaseRetryAfterSeconds(retryAfterMs: number | undefined): number {
	if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
		return PROJECTION_RETRY_AFTER_MAX_SECONDS;
	}
	return Math.min(PROJECTION_RETRY_AFTER_MAX_SECONDS, Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

function clientDisconnected(projectedSeq: string): DrainFailure {
	return {
		ok: false,
		error: "projection_client_disconnected",
		projectedSeq,
		httpStatus: 503,
		retryable: true,
	};
}

export type DrainResult = DrainSuccess | DrainFailure;

export interface ProjectionFetchResult {
	ok: boolean;
	status: number;
	bodyText: string;
}

export type ProjectionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchProjectionWithTimeout(
	url: string,
	requestBody: string,
	secret: string,
	timeoutMs = PROJECTION_FETCH_TIMEOUT_MS,
	fetchImpl: ProjectionFetch = fetch,
): Promise<ProjectionFetchResult> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= PROJECTION_LEASE_MS) {
		throw new Error("projection timeout must be a positive safe integer strictly shorter than the Hub lease");
	}
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			controller.abort("projection fetch deadline exceeded");
			reject(new Error("projection_upstream_timeout"));
		}, timeoutMs);
	});
	const request = (async (): Promise<ProjectionFetchResult> => {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${secret}`,
			},
			body: requestBody,
			signal: controller.signal,
		});
		const bodyText = await response.text();
		return { ok: response.ok, status: response.status, bodyText };
	})();
	try {
		return await Promise.race([request, deadline]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export interface ProjectionDrainDependencies {
	fetchTimeoutMs?: number;
	fetchImpl?: ProjectionFetch;
	now?: () => number;
	maxPages?: number;
	/**
	 * The inbound request's signal; it aborts when the client stops waiting.
	 * Checked only before the lease is taken and between pages, where no
	 * upstream request can still be in flight, so a departed client never
	 * shortens the fence around an ambiguous in-flight projection.
	 */
	clientSignal?: AbortSignal;
}

function projectionNow(dependencies: ProjectionDrainDependencies): number | undefined {
	return dependencies.now?.();
}

export function decimalAtLeast(left: string, right: string): boolean {
	if (!CANONICAL_DECIMAL.test(left) || !CANONICAL_DECIMAL.test(right)) return false;
	if (left.length !== right.length) return left.length > right.length;
	return left >= right;
}

export async function drainProjection(
	env: SyncApiEnv,
	store: HubStore,
	userId: string,
	targetSeq: string,
	dependencies: ProjectionDrainDependencies = {},
): Promise<DrainResult> {
	if (
		dependencies.maxPages !== undefined
		&& (!Number.isSafeInteger(dependencies.maxPages) || dependencies.maxPages < 1)
	) {
		throw new Error("projection maxPages must be a positive safe integer");
	}
	let state;
	try {
		state = await store.getProjectionState(userId);
	} catch (error) {
		console.error("sync-hub projection drain: getProjectionState failed:", error);
		return {
			ok: false,
			error: "sync_hub_unavailable",
			projectedSeq: "0",
			httpStatus: 503,
			retryable: true,
		};
	}
	if (decimalAtLeast(state.projected_seq, targetSeq)) {
		return { ok: true, projectedSeq: state.projected_seq };
	}
	if (!env.INTERNAL_PROJECTOR_URL || !env.CMEM_INTERNAL_PROJECTOR_SECRET) {
		return {
			ok: false,
			error: "projection_not_configured",
			projectedSeq: state.projected_seq,
			httpStatus: 503,
			retryable: true,
		};
	}
	if (dependencies.clientSignal?.aborted) {
		// Nobody is waiting and nothing is leased yet: taking a lease for a
		// departed client would only make the next push answer projection_busy.
		return clientDisconnected(state.projected_seq);
	}
	const acquiredAt = projectionNow(dependencies);
	const lease = acquiredAt === undefined
		? await store.acquireProjectionLease(userId, targetSeq)
		: await store.acquireProjectionLease(userId, targetSeq, acquiredAt);
	if (decimalAtLeast(lease.projected_seq, targetSeq)) {
		if (lease.acquired && lease.lease_token) {
			await store.releaseProjectionLease(userId, lease.lease_token);
		}
		return { ok: true, projectedSeq: lease.projected_seq };
	}
	if (!lease.acquired || !lease.lease_token) {
		return {
			ok: false,
			error: "projection_busy",
			projectedSeq: lease.projected_seq,
			httpStatus: 503,
			retryable: true,
			retryAfterSeconds: leaseRetryAfterSeconds(lease.retry_after_ms),
		};
	}

	const token = lease.lease_token;
	// The lease is kept past this drain only while a sent request's outcome is
	// unknown (set false just before each fetch). Until the first fetch nothing
	// is in flight, so a local terminal failure (an empty or oversize page, a
	// thrown store error, a departed client) hands the lease straight to the
	// next push instead of answering projection_busy for the full lease.
	let releaseLeaseEarly = true;
	let projectedPages = 0;
	let projectedSeq = lease.projected_seq;
	try {
		for (;;) {
			if (decimalAtLeast(projectedSeq, targetSeq)) {
				releaseLeaseEarly = true;
				return { ok: true, projectedSeq };
			}
			if (dependencies.clientSignal?.aborted) {
				// Between pages the previous page either checkpointed or never
				// started, so nothing upstream can still be applying. Pages already
				// checkpointed stay; the lease goes straight to the next push.
				return clientDisconnected(projectedSeq);
			}
			const pageAt = projectionNow(dependencies);
			const page = pageAt === undefined
				? await store.getProjectionPage(
					userId,
					token,
					targetSeq,
					userId,
					PROJECTION_PAGE_MAX_OPS,
					PROJECTION_PAGE_MAX_BYTES,
				)
				: await store.getProjectionPage(
					userId,
					token,
					targetSeq,
					userId,
					PROJECTION_PAGE_MAX_OPS,
					PROJECTION_PAGE_MAX_BYTES,
					pageAt,
				);
			if (page.ops.length === 0) {
				return {
					ok: false,
					error: "projection_page_empty",
					projectedSeq,
					httpStatus: 503,
					retryable: true,
				};
			}
			const requestBody = serializeProjectionRequest({
				userId,
				epoch: page.epoch,
				fromSeqExclusive: page.from_seq_exclusive,
				throughSeq: page.through_seq,
				ops: page.ops,
			});
			if (encoder.encode(requestBody).length > PROJECTION_PAGE_MAX_BYTES) {
				return {
					ok: false,
					error: "projection_page_too_large",
					projectedSeq,
					httpStatus: 503,
					retryable: true,
				};
			}
			releaseLeaseEarly = false;
			let response: ProjectionFetchResult;
			try {
				response = await fetchProjectionWithTimeout(
					env.INTERNAL_PROJECTOR_URL,
					requestBody,
					env.CMEM_INTERNAL_PROJECTOR_SECRET,
					dependencies.fetchTimeoutMs,
					dependencies.fetchImpl,
				);
			} catch (error) {
				if (error instanceof Error && error.message === "projection_upstream_timeout") {
					return {
						ok: false,
						error: error.message,
						projectedSeq,
						httpStatus: 503,
						retryable: true,
					};
				}
				return {
					ok: false,
					error: "projection_upstream_unreachable",
					projectedSeq,
					httpStatus: 503,
					retryable: true,
				};
			}
			if (!response.ok) {
				if (response.status === 409) {
					releaseLeaseEarly = true;
					return {
						ok: false,
						error: "projection_upstream_409",
						projectedSeq,
						httpStatus: 409,
						retryable: false,
					};
				}
				return {
					ok: false,
					error: `projection_upstream_${response.status}`,
					projectedSeq,
					httpStatus: 503,
					retryable: true,
				};
			}
			let projected: unknown;
			try { projected = JSON.parse(response.bodyText); } catch {
				return {
					ok: false,
					error: "projection_response_not_json",
					projectedSeq,
					httpStatus: 503,
					retryable: true,
				};
			}
			const result = projected as Record<string, unknown>;
			if (
				result.protocol_version !== PROJECTION_PROTOCOL_VERSION
				|| result.epoch !== page.epoch
				|| result.projected_through_seq !== page.through_seq
			) {
				return {
					ok: false,
					error: "projection_response_mismatch",
					projectedSeq,
					httpStatus: 503,
					retryable: true,
				};
			}
			const checkpointAt = projectionNow(dependencies);
			state = checkpointAt === undefined
				? await store.advanceProjectionCheckpoint(
					userId,
					token,
					page.epoch,
					page.from_seq_exclusive,
					page.through_seq,
				)
				: await store.advanceProjectionCheckpoint(
					userId,
					token,
					page.epoch,
					page.from_seq_exclusive,
					page.through_seq,
					checkpointAt,
				);
			projectedSeq = state.projected_seq;
			releaseLeaseEarly = true;
			projectedPages++;
			if (
				dependencies.maxPages !== undefined
				&& projectedPages >= dependencies.maxPages
				&& !decimalAtLeast(projectedSeq, targetSeq)
			) {
				return { ok: true, projectedSeq };
			}
		}
	} catch (error) {
		let checkpoint = projectedSeq;
		try {
			checkpoint = (await store.getProjectionState(userId)).projected_seq;
		} catch (stateError) {
			console.error("sync-hub projection drain: checkpoint read failed:", stateError);
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message : "projection_failed",
			projectedSeq: checkpoint,
			httpStatus: 503,
			retryable: true,
		};
	} finally {
		if (releaseLeaseEarly) await store.releaseProjectionLease(userId, token);
	}
}
