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
 * The host part of a URL authority. An IPv6 literal must be bracketed
 * (`http://[::1]:8080`); `http://::1:8080` is not a valid URL and Bun/Node
 * reject it before connecting. Bare literals (any `:`) get brackets; an
 * already-bracketed host and an IPv4 host pass through unchanged.
 */
export function formatHostForUrl(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) return host;
	return host.includes(":") ? `[${host}]` : host;
}

/**
 * An absolute https endpoint (plain http only for a loopback host, which is
 * what tests and `supabase start` use) with no query, fragment or credentials.
 * `label` names the variable in every error so the fix is obvious from the
 * message alone. Unset or blank means "not configured": null.
 */
function parseHttpsEndpoint(raw: string | undefined, label: string): string | null {
	const trimmed = (raw ?? "").trim();
	if (trimmed.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${label} is not a valid URL: ${trimmed}`);
	}
	const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname);
	if (parsed.protocol !== "https:" && !isLoopbackHttp) {
		throw new Error(`${label} must use https:// (http:// only for loopback hosts)`);
	}
	if (parsed.search !== "" || parsed.hash !== "" || trimmed.includes("?") || trimmed.includes("#")) {
		throw new Error(`${label} must not contain a query string or fragment`);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new Error(`${label} must not contain credentials`);
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * FORWARD_ORIGIN must be an absolute https:// URL (a path prefix such as
 * `/functions/v1/cmem-sync` is allowed) with no query, fragment or
 * credentials. Plain http:// is accepted only for loopback hosts (tests and
 * local dev against `supabase start`). Unset/blank ⇒ null (hub mode).
 */
export function parseForwardOrigin(raw: string | undefined): string | null {
	return parseHttpsEndpoint(raw, "FORWARD_ORIGIN");
}

/**
 * The Pro projector endpoint that receives `Authorization: Bearer
 * <CMEM_INTERNAL_PROJECTOR_SECRET>` on every drain. It follows the same rules
 * as the forward origin so an operator typo fails at startup instead of
 * sending that secret in cleartext to a non-loopback http host. Unset/blank
 * means projection is not configured, which projection.ts already reports as
 * `projection_not_configured`.
 */
export function parseInternalProjectorUrl(raw: string | undefined): string {
	return parseHttpsEndpoint(raw, "INTERNAL_PROJECTOR_URL") ?? "";
}

const DEFAULT_TOKEN_VERIFY_URL = "https://cmem.ai/api/pro/sync/verify";

/**
 * The Pro token-verification endpoint. Every authenticated sync request sends
 * the caller's `Authorization: Bearer <token>` here, so it follows the same
 * rules as the forward origin and the projector URL: https, or http only for a
 * loopback host, with no query, fragment or credentials. Unset or blank means
 * the production endpoint.
 */
export function parseTokenVerifyUrl(raw: string | undefined): string {
	return parseHttpsEndpoint(raw, "TOKEN_VERIFY_URL") ?? DEFAULT_TOKEN_VERIFY_URL;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): SyncApiEnv {
	const forwardOrigin = parseForwardOrigin(source.FORWARD_ORIGIN);
	const internalProjectorUrl = parseInternalProjectorUrl(source.INTERNAL_PROJECTOR_URL);
	const databaseUrl = (source.DATABASE_URL ?? "").trim();
	if (!databaseUrl && forwardOrigin === null) {
		throw new Error("DATABASE_URL is required (unless FORWARD_ORIGIN is set)");
	}
	const portRaw = (source.PORT ?? "8080").trim();
	const port = Number(portRaw);
	if (!/^\d+$/.test(portRaw) || port > 65535) {
		throw new Error("PORT must be an integer 0–65535");
	}
	return {
		DATABASE_URL: forwardOrigin === null ? databaseUrl : "",
		TOKEN_VERIFY_URL: parseTokenVerifyUrl(source.TOKEN_VERIFY_URL),
		AUTH_CACHE_TTL_SECONDS: (source.AUTH_CACHE_TTL_SECONDS ?? String(AUTH_CACHE_TTL_DEFAULT_SECONDS)).trim(),
		INTERNAL_PROJECTOR_URL: internalProjectorUrl,
		CMEM_INTERNAL_PROJECTOR_SECRET: (source.CMEM_INTERNAL_PROJECTOR_SECRET ?? "").trim(),
		FORWARD_ORIGIN: forwardOrigin,
		PORT: port,
		HOST: (source.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
	};
}
