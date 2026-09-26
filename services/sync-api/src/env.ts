export interface SyncApiEnv {
	DATABASE_URL: string;
	TOKEN_VERIFY_URL: string;
	AUTH_CACHE_TTL_SECONDS: string;
	INTERNAL_PROJECTOR_URL: string;
	CMEM_INTERNAL_PROJECTOR_SECRET: string;
	PORT: number;
	HOST: string;
}

export const AUTH_CACHE_TTL_MIN_SECONDS = 60;
export const AUTH_CACHE_TTL_MAX_SECONDS = 3_600;
export const AUTH_CACHE_TTL_DEFAULT_SECONDS = 900;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): SyncApiEnv {
	const databaseUrl = (source.DATABASE_URL ?? "").trim();
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required");
	}
	const portRaw = source.PORT ?? "8080";
	const port = portRaw === "0" ? 0 : Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) {
		throw new Error("PORT must be an integer 0–65535");
	}
	return {
		DATABASE_URL: databaseUrl,
		TOKEN_VERIFY_URL: (source.TOKEN_VERIFY_URL ?? "https://cmem.ai/api/pro/sync/verify").trim(),
		AUTH_CACHE_TTL_SECONDS: (source.AUTH_CACHE_TTL_SECONDS ?? String(AUTH_CACHE_TTL_DEFAULT_SECONDS)).trim(),
		INTERNAL_PROJECTOR_URL: (source.INTERNAL_PROJECTOR_URL ?? "").trim(),
		CMEM_INTERNAL_PROJECTOR_SECRET: (source.CMEM_INTERNAL_PROJECTOR_SECRET ?? "").trim(),
		PORT: port,
		HOST: (source.HOST ?? "0.0.0.0").trim() || "0.0.0.0",
	};
}
