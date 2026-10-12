import type { Miniflare } from "miniflare";
import { createSyncHubMiniflare as createRuntimeHarness } from "./miniflare-pro-e2e-node.mjs";

export interface SyncHubMiniflareHarnessInput {
	/** Caller-supplied path to workers/sync-hub; relative paths are supported. */
	workerRoot: string;
	internalProjectorUrl: string;
	tokenVerifyUrl: string;
	internalProjectorSecret: string;
	durableObjectsPersist?: boolean | string;
	host?: string;
	port?: number;
}

/**
 * Typed import surface for TypeScript E2E orchestrators. The runtime lives in
 * the adjacent .mjs file so plain Node 20+ can start it without a TS loader.
 */
export const createSyncHubMiniflare: (
	input: SyncHubMiniflareHarnessInput,
) => Promise<Miniflare> = createRuntimeHarness;
