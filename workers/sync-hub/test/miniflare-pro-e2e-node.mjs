import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Start the actual bundled Worker entry and SQLite SyncHub Durable Object.
 * Outbound fetch is intentionally untouched, so loopback Pro receives the
 * projection request. The caller owns `await miniflare.dispose()`.
 *
 * @param {{
 *   workerRoot: string;
 *   internalProjectorUrl: string;
 *   tokenVerifyUrl: string;
 *   internalProjectorSecret: string;
 *   durableObjectsPersist?: boolean|string;
 *   host?: string;
 *   port?: number;
 * }} input
 * @returns {Promise<Miniflare>}
 */
export async function createSyncHubMiniflare(input) {
	for (const [name, url] of [
		["INTERNAL_PROJECTOR_URL", input.internalProjectorUrl],
		["TOKEN_VERIFY_URL", input.tokenVerifyUrl],
	]) {
		if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::[0-9]+)?\//.test(url)) {
			throw new Error(`${name} must be an explicit loopback URL for Pro E2E`);
		}
	}
	if (input.internalProjectorSecret.length < 32) {
		throw new Error("Pro E2E projector secret must contain at least 32 characters");
	}
	if (input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535)) {
		throw new Error("Miniflare port must be an integer from 0 through 65535");
	}

	const workerRoot = resolve(input.workerRoot);
	const bundle = await build({
		entryPoints: [resolve(workerRoot, "src/index.ts")],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		target: "es2024",
		conditions: ["workerd", "worker", "browser"],
		external: ["cloudflare:workers"],
	});
	const script = bundle.outputFiles[0]?.text;
	if (!script) throw new Error("SyncHub Worker bundle produced no JavaScript");

	const miniflare = new Miniflare({
		host: input.host ?? "127.0.0.1",
		port: input.port ?? 0,
		modules: true,
		script,
		modulesRoot: workerRoot,
		compatibilityDate: "2026-07-14",
		durableObjects: {
			SYNC_HUB: { className: "SyncHub", useSQLite: true },
		},
		durableObjectsPersist: input.durableObjectsPersist ?? false,
		kvNamespaces: ["AUTH_CACHE"],
		bindings: {
			TOKEN_VERIFY_URL: input.tokenVerifyUrl,
			AUTH_CACHE_TTL_SECONDS: "60",
			INTERNAL_PROJECTOR_URL: input.internalProjectorUrl,
			CMEM_INTERNAL_PROJECTOR_SECRET: input.internalProjectorSecret,
			KILL_SWITCH_CACHE_MS: "0",
			ACCOUNT_ID: "",
			WATCHDOG_DO_NAMESPACE_ID: "",
			WATCHDOG_SCRIPT_NAME: "",
			WATCHDOG_REQUESTS_ALERT: "",
			WATCHDOG_REQUESTS_KILL: "",
			WATCHDOG_DURATION_ALERT_GBS: "",
			WATCHDOG_DURATION_KILL_GBS: "",
			WATCHDOG_ROWS_WRITTEN_ALERT: "",
			WATCHDOG_ROWS_WRITTEN_KILL: "",
			WATCHDOG_ROWS_READ_ALERT: "",
			WATCHDOG_ROWS_READ_KILL: "",
		},
	});
	await miniflare.ready;
	return miniflare;
}
