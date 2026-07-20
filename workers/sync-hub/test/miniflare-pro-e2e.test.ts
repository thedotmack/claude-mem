import { describe, expect, it } from "vitest";
import { createSyncHubMiniflareE2EOptions } from "./miniflare-pro-e2e";

describe("cross-repository Miniflare hook", () => {
	it("uses the real Worker/DO entry and caller projection URL without an outbound mock", () => {
		const options = createSyncHubMiniflareE2EOptions({
			workerRoot: "../claude-mem/workers/sync-hub",
			internalProjectorUrl: "http://127.0.0.1:3005/api/internal/sync/project",
			tokenVerifyUrl: "http://127.0.0.1:3005/api/pro/sync/verify",
			internalProjectorSecret: "local-e2e-projector-secret-32-chars",
		});
		expect(options.main).toBe("../claude-mem/workers/sync-hub/src/index.ts");
		expect(options.wrangler.configPath).toBe("../claude-mem/workers/sync-hub/wrangler.jsonc");
		expect(options.miniflare.bindings.INTERNAL_PROJECTOR_URL)
			.toBe("http://127.0.0.1:3005/api/internal/sync/project");
		expect(options.miniflare).not.toHaveProperty("outboundService");
	});

	it("refuses non-loopback targets and short shared secrets", () => {
		expect(() => createSyncHubMiniflareE2EOptions({
			workerRoot: ".",
			internalProjectorUrl: "https://cmem.ai/api/internal/sync/project",
			tokenVerifyUrl: "http://127.0.0.1:3005/api/pro/sync/verify",
			internalProjectorSecret: "local-e2e-projector-secret-32-chars",
		})).toThrow(/loopback/);
		expect(() => createSyncHubMiniflareE2EOptions({
			workerRoot: ".",
			internalProjectorUrl: "http://127.0.0.1:3005/api/internal/sync/project",
			tokenVerifyUrl: "http://127.0.0.1:3005/api/pro/sync/verify",
			internalProjectorSecret: "short",
		})).toThrow(/32/);
	});
});
