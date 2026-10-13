export interface SyncApiEnv {
	/** Empty in forward mode (no Postgres is opened). */
	DATABASE_URL: string;
	TOKEN_VERIFY_URL: string;
	AUTH_CACHE_TTL_SECONDS: string;
	INTERNAL_PROJECTOR_URL: string;
	CMEM_INTERNAL_PROJECTOR_SECRET: string;
	/**
	 * Forward mode: when set, every /v1/sync/* request is proxied to
	 * `${FORWARD_ORIGIN}${pathname}${search}` and no Postgres is opened.
	 * Normalized (no trailing slash). null = normal hub mode.
	 */
	FORWARD_ORIGIN: string | null;
	PORT: number;
	HOST: string;
}

export const AUTH_CACHE_TTL_MIN_SECONDS = 60;
export const AUTH_CACHE_TTL_MAX_SECONDS = 3_600;
export const AUTH_CACHE_TTL_DEFAULT_SECONDS = 900;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * FORWARD_ORIGIN must be an absolute https:// URL (a path prefix such as
 * `/functions/v1/cmem-sync` is allowed) with no query, fragment or
 * credentials. Plain http:// is accepted only for loopback hosts (tests and
 * local dev against `supabase start`). Unset/blank ⇒ null (hub mode).
 */
export function parseForwardOrigin(raw: string | undefined): string | null {
	const trimmed = (raw ?? "").trim();
	if (trimmed.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`FORWARD_ORIGIN is not a valid URL: ${trimmed}`);
	}
	const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname);
	if (parsed.protocol !== "https:" && !isLoopbackHttp) {
		throw new Error("FORWARD_ORIGIN must use https:// (http:// only for loopback hosts)");
	}
	if (parsed.search !== "" || parsed.hash !== "" || trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error("FORWARD_ORIGIN must not contain a query string or fragment");
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new Error("FORWARD_ORIGIN must not contain credentials");
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): SyncApiEnv {
	const forwardOrigin = parseForwardOrigin(source.FORWARD_ORIGIN);
	const databaseUrl = (source.DATABASE_URL ?? "").trim();
	if (!databaseUrl && forwardOrigin === null) {
		throw new Error("DATABASE_URL is required (unless FORWARD_ORIGIN is set)");
	}
	const portRaw = source.PORT ?? "8080";
	const port = portRaw === "0" ? 0 : Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) {
		throw new Error("PORT must be an integer 0–65535");
	}
	return {
		DATABASE_URL: forwardOrigin === null ? databaseUrl : "",
		TOKEN_VERIFY_URL: (source.TOKEN_VERIFY_URL ?? "https://cmem.ai/api/pro/sync/verify").trim(),
		AUTH_CACHE_TTL_SECONDS: (source.AUTH_CACHE_TTL_SECONDS ?? String(AUTH_CACHE_TTL_DEFAULT_SECONDS)).trim(),
		INTERNAL_PROJECTOR_URL: (source.INTERNAL_PROJECTOR_URL ?? "").trim(),
		CMEM_INTERNAL_PROJECTOR_SECRET: (source.CMEM_INTERNAL_PROJECTOR_SECRET ?? "").trim(),
		FORWARD_ORIGIN: forwardOrigin,
		PORT: port,
		HOST: (source.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
	};
}
