/**
 * Reusable Cloudflare Vitest/Miniflare options for cross-repository Pro E2E.
 *
 * Unlike vitest.config.ts, this deliberately installs no outboundService mock:
 * fetches from the real Worker entry reach the caller-supplied loopback Pro
 * projection and verification routes. Paths are supplied relative to the
 * invoking repository; no workstation-specific absolute path is embedded.
 */

export interface SyncHubMiniflareE2EInput {
	/** Path from the invoking Vitest root to workers/sync-hub. */
	workerRoot: string;
	internalProjectorUrl: string;
	tokenVerifyUrl: string;
	internalProjectorSecret: string;
}

function childPath(root: string, child: string): string {
	return `${root.replace(/\/$/, "")}/${child}`;
}

export function createSyncHubMiniflareE2EOptions(input: SyncHubMiniflareE2EInput) {
	if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\//.test(input.internalProjectorUrl)) {
		throw new Error("Pro E2E INTERNAL_PROJECTOR_URL must be an explicit loopback URL");
	}
	if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\//.test(input.tokenVerifyUrl)) {
		throw new Error("Pro E2E TOKEN_VERIFY_URL must be an explicit loopback URL");
	}
	if (input.internalProjectorSecret.length < 32) {
		throw new Error("Pro E2E projector secret must contain at least 32 characters");
	}
	return {
		main: childPath(input.workerRoot, "src/index.ts"),
		wrangler: { configPath: childPath(input.workerRoot, "wrangler.jsonc") },
		miniflare: {
			bindings: {
				INTERNAL_PROJECTOR_URL: input.internalProjectorUrl,
				TOKEN_VERIFY_URL: input.tokenVerifyUrl,
				CMEM_INTERNAL_PROJECTOR_SECRET: input.internalProjectorSecret,
				KILL_SWITCH_CACHE_MS: "0",
			},
		},
	};
}
