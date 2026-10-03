/**
 * Vitest config for the self-hosted, end-to-end encrypted hub
 * (wrangler.self-host.jsonc). Separate from vitest.config.ts because the mode
 * is chosen by bindings for the whole Worker. Every outbound fetch fails: the
 * self-hosted hub must never call cmem.ai (or anything else).
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export const SELF_HOST_TEST_TOKEN = "self-host-test-token";
export const SELF_HOST_TEST_USER = "self-host-user";

export default defineConfig({
	test: {
		include: ["test/self-host.test.ts"],
	},
	plugins: [
		cloudflareTest({
			main: "./src/self-host-entry.ts",
			wrangler: { configPath: "./wrangler.self-host.jsonc" },
			miniflare: {
				bindings: {
					SELF_HOST_TOKEN: SELF_HOST_TEST_TOKEN,
					SELF_HOST_USER_ID: SELF_HOST_TEST_USER,
				},
				outboundService: (request: Request) => {
					throw new Error(`self-hosted hub made an outbound request to ${request.url}`);
				},
			},
		}),
	],
});
