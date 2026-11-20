import { Redis } from "@upstash/redis";

type LimitOptions = {
  readonly key: string;
  readonly limit: number;
  readonly prefix: string;
  readonly windowSeconds: number;
};

export class RateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Too many requests. Please wait a moment and try again.");
    this.retryAfter = retryAfter;
  }
}

let redis: Redis | null | undefined;

function getRedisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() || process.env.KV_REST_API_URL?.trim();
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || process.env.KV_REST_API_TOKEN?.trim();

  return url && token ? { token, url } : null;
}

function getRedis() {
  if (redis !== undefined) {
    return redis;
  }

  const env = getRedisEnv();

  if (!env) {
    redis = null;
    return redis;
  }

  redis = new Redis(env);
  return redis;
}

export async function enforceRateLimit(options: LimitOptions) {
  const client = getRedis();

  if (!client) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(now / options.windowSeconds);
  const redisKey = `rate:${options.prefix}:${options.key}:${windowId}`;
  const count = await client.incr(redisKey);

  if (count === 1) {
    await client.expire(redisKey, options.windowSeconds);
  }

  if (count > options.limit) {
    const retryAfter = options.windowSeconds - (now % options.windowSeconds);
    throw new RateLimitError(retryAfter);
  }
}
