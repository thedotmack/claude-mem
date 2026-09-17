// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-key rotation for the OpenAI-compatible providers.
 *
 * THE PROBLEM. Every provider resolves exactly one API key, and no classified
 * failure re-decides it. A free-tier Gemini or OpenRouter key has a daily
 * allowance measured in a few hundred requests; an ordinary day of capture
 * spends it before evening. What happens then is not a slowdown but a stop:
 * `rate_limit` is retried two more times against the SAME exhausted key
 * (honoring a `retryAfterMs` that is 60s by default, so the session stalls a
 * full minute per observation before failing anyway), and
 * `quota_exhausted` / `auth_invalid` are not retryable at all — they throw
 * straight out of `withRetry`, the generator exits, and the quota breaker
 * (#3634) arms the whole provider shut for 30 minutes.
 *
 * Users answer this today by keeping several free keys and editing
 * settings.json when one dies. That is the loop this module closes.
 *
 * THE SHAPE. A pool is an ordered list of keys for one provider. A key that
 * earns a `rate_limit`, `quota_exhausted`, or `auth_invalid` is put in
 * cooldown for a kind-specific window, and the next request picks the first
 * key not in cooldown. Rotation happens OUTSIDE `withRetry`, wrapping it: the
 * inner retry still handles transient failures against one key, and this outer
 * loop moves to the next key on the three kinds that mean "this key, not this
 * request, is the problem". A success clears that key's cooldown immediately.
 *
 * WHAT DOES NOT CHANGE. A pool of one key is a pass-through: `withKeyPool`
 * runs the body once and records nothing, so single-key installs — which is
 * every install today — keep byte-identical behavior, including which error
 * escapes and when the quota breaker arms. Cross-provider dispatch
 * (`provider-dispatch.ts`) is untouched; this rotates keys within the provider
 * the user selected, and hands the last classified error back unchanged when
 * every key is spent, so the existing pause/breaker paths still see what they
 * expect.
 *
 * PERSISTENCE. The cooldown windows are written beside `quota-cooldown.json`
 * and hydrated once per process, for the reason that module's docblock already
 * argues at length: an in-memory-only window is cleared by every restart, and
 * a crash-respawn loop would rediscover each dead key once per restart —
 * exactly the storm the quota breaker exists to prevent, relocated one level
 * down.
 *
 * Keys are NEVER written to disk or to a log line, not even truncated. The
 * cooldown file is keyed by a salted-per-file fingerprint, and every log line
 * carries the pool index plus that fingerprint. The fingerprint is stable
 * within an install (so a window survives a restart) and useless outside it.
 */

import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

/** Which pools exist. One per provider that resolves an HTTP API key. */
export type KeyPoolId = 'gemini' | 'openrouter';

export const API_KEY_COOLDOWN_FILENAME = 'api-key-cooldown.json';

/**
 * Cap on keys accepted from one setting. A pool larger than this is far more
 * likely to be a pasted file than an intent, and every entry costs one doomed
 * request per rotation sweep.
 */
export const MAX_POOL_KEYS = 32;

/**
 * How long a key sits out, by what it did.
 *
 * `rate_limit` is short because it is a per-minute window and the key is fine
 * afterwards; the provider's own `Retry-After` wins when it sends one, clamped
 * so a hostile or careless header cannot park a key for a day.
 *
 * `quota_exhausted` is a daily allowance in practice, but a 24h window would
 * make a wrongly-classified error cost a full day of that key. 30 minutes
 * matches `QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS` — one re-probe per window is
 * cheap, and it means a key whose allowance resets is picked up on its own.
 *
 * `auth_invalid` is a bad or revoked key, which no waiting repairs. It gets the
 * longest window purely so a typo'd entry stops costing a request per sweep;
 * correcting the key changes its fingerprint, so a fix takes effect at once
 * rather than waiting this out.
 */
export const KEY_COOLDOWN_MS: Record<string, number> = {
  rate_limit: 60_000,
  quota_exhausted: 30 * 60_000,
  auth_invalid: 6 * 60 * 60_000,
};

const RATE_LIMIT_COOLDOWN_MIN_MS = 1_000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 15 * 60_000;

/** The kinds that mean "this key is the problem", not "this request failed". */
const ROTATE_KINDS = new Set(['rate_limit', 'quota_exhausted', 'auth_invalid']);

/**
 * The same three kinds as a list, for `withRetry`'s `nonRetryableKinds`.
 *
 * A pooled call must not retry these in place: the inner retry would honor
 * `retryAfterMs` against the very key the pool is trying to move off, spending
 * the window rotation exists to avoid. Only pass this when the pool actually
 * has somewhere to rotate TO — with a single key, waiting out a rate limit is
 * still the best available move, and that path must stay unchanged.
 */
export const KEY_ROTATE_KINDS: readonly string[] = [...ROTATE_KINDS];

/**
 * The `withRetry` options a pooled request should add, given its pool size.
 *
 * Empty for a pool of one, which is what keeps every single-key install
 * byte-identical.
 */
export function retryPolicyForPool(poolSize: number): { nonRetryableKinds?: readonly string[] } {
  return poolSize > 1 ? { nonRetryableKinds: KEY_ROTATE_KINDS } : {};
}

/**
 * The shape this module needs from a classified provider error.
 *
 * Read structurally rather than by importing `ClassifiedProviderError`, for two
 * reasons: `src/shared/` should not take a runtime dependency on
 * `src/services/worker/`, and the server runtime deliberately keeps its own
 * error-classification module
 * (`src/server/generation/providers/shared/error-classification.ts`) with the
 * same `kind` / `retryAfterMs` contract. A structural read serves both without
 * either importing the other.
 */
interface ClassifiedLike {
  kind: string;
  retryAfterMs?: number;
}

function asClassified(err: unknown): ClassifiedLike | null {
  if (!err || typeof err !== 'object') return null;
  const kind = (err as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return null;
  const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return {
    kind,
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
  };
}

/**
 * True when a classified error should retire the key that earned it and move
 * the pool on. Unclassified and `transient` errors are deliberately excluded:
 * `withRetry` already owns those, and rotating on them would spend the whole
 * pool on one flaky network moment.
 */
export function shouldRotateKey(err: unknown): boolean {
  const classified = asClassified(err);
  return classified !== null && ROTATE_KINDS.has(classified.kind);
}

/**
 * Split a key list setting into keys.
 *
 * Accepts a newline-, comma-, or whitespace-separated string (all three, mixed
 * — a pasted column and a pasted CSV both work), or an array, since
 * settings.json is hand-edited and `CLAUDE_MEM_OPENROUTER_MODEL` already
 * tolerates both shapes. Blanks are dropped, order is preserved, and repeats
 * are collapsed — a duplicated key would otherwise get two cooldown slots and
 * two doomed requests per sweep.
 */
export function parseApiKeyList(raw: unknown): string[] {
  const parts: string[] = Array.isArray(raw)
    ? raw.flatMap(entry => splitKeyString(String(entry)))
    : typeof raw === 'string'
      ? splitKeyString(raw)
      : [];

  const seen = new Set<string>();
  const keys: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    keys.push(part);
    if (keys.length >= MAX_POOL_KEYS) break;
  }
  return keys;
}

function splitKeyString(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/**
 * Assemble a provider's pool: the primary key first, then the list.
 *
 * The primary is whatever that provider's existing single-key resolution
 * produced, and it stays index 0 — so with no list configured the pool is
 * `[primary]` and nothing about the request path changes. When only a list is
 * configured the caller passes `primary = ''` and the pool is just the list;
 * providers derive their `apiKey` field from `pool[0]` in that case, which is
 * what keeps `isGeminiAvailable()` / `isOpenRouterAvailable()` honest.
 */
export function buildKeyPool(primary: string, listRaw: unknown): string[] {
  const listed = parseApiKeyList(listRaw);
  const primaryTrimmed = primary.trim();
  if (!primaryTrimmed) return listed;
  return parseApiKeyList([primaryTrimmed, ...listed]);
}

/* -------------------------------------------------------------------------- */
/* Cooldown state                                                             */
/* -------------------------------------------------------------------------- */

interface KeyCooldown {
  /** Fingerprint, never the key. */
  fingerprint: string;
  kind: string;
  untilMs: number;
}

interface PersistedCooldownFile {
  /** Per-install salt, so a fingerprint is meaningless outside this file. */
  salt: string;
  pools: Record<string, KeyCooldown[]>;
}

let salt: string | null = null;
let cooldowns: Map<string, Map<string, KeyCooldown>> = new Map();
let hydrated = false;

function cooldownFilePath(): string {
  return join(paths.dataDir(), API_KEY_COOLDOWN_FILENAME);
}

/**
 * Fingerprint a key for logs and for the cooldown file.
 *
 * Salted so the file cannot be used to confirm a guessed key, and truncated
 * because 12 hex characters over a pool capped at 32 entries is far past the
 * point where a collision is plausible.
 */
export function keyFingerprint(key: string): string {
  hydrate();
  return createHash('sha256').update(`${salt ?? ''}:${key}`).digest('hex').slice(0, 12);
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const filePath = cooldownFilePath();
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedCooldownFile;
      if (parsed && typeof parsed.salt === 'string' && parsed.salt) {
        salt = parsed.salt;
        const now = Date.now();
        for (const [poolId, entries] of Object.entries(parsed.pools ?? {})) {
          if (!Array.isArray(entries)) continue;
          const pool = new Map<string, KeyCooldown>();
          for (const entry of entries) {
            // Drop windows that elapsed while the process was down rather than
            // carrying them forward — a restart must not extend a cooldown.
            if (!entry || typeof entry.fingerprint !== 'string') continue;
            if (typeof entry.untilMs !== 'number' || entry.untilMs <= now) continue;
            pool.set(entry.fingerprint, {
              fingerprint: entry.fingerprint,
              kind: typeof entry.kind === 'string' ? entry.kind : 'rate_limit',
              untilMs: entry.untilMs,
            });
          }
          if (pool.size > 0) cooldowns.set(poolId, pool);
        }
      }
    }
  } catch (err) {
    // A corrupt or unreadable file must never block inference: start clean.
    logger.warn('SDK', 'Could not read API key cooldown file; starting with an empty pool state', {
      error: err instanceof Error ? err.message : String(err),
    });
    cooldowns = new Map();
    salt = null;
  }
  if (!salt) {
    salt = randomBytes(16).toString('hex');
  }
}

function persist(): void {
  const filePath = cooldownFilePath();
  const payload: PersistedCooldownFile = { salt: salt ?? '', pools: {} };
  for (const [poolId, pool] of cooldowns) {
    const entries = [...pool.values()];
    if (entries.length > 0) payload.pools[poolId] = entries;
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (err) {
    // Losing the window costs one extra doomed request after a restart. It is
    // not worth failing an observation over.
    logger.debug('SDK', 'Could not persist API key cooldown file', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function poolState(poolId: KeyPoolId): Map<string, KeyCooldown> {
  hydrate();
  let pool = cooldowns.get(poolId);
  if (!pool) {
    pool = new Map();
    cooldowns.set(poolId, pool);
  }
  return pool;
}

function cooldownMsFor(kind: string, retryAfterMs: number | undefined): number {
  if (kind === 'rate_limit' && retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, RATE_LIMIT_COOLDOWN_MIN_MS), RATE_LIMIT_COOLDOWN_MAX_MS);
  }
  return KEY_COOLDOWN_MS[kind] ?? KEY_COOLDOWN_MS.rate_limit;
}

/** Put a key in cooldown for the window its failure kind earns. */
export function markKeyCooldown(
  poolId: KeyPoolId,
  key: string,
  kind: string,
  retryAfterMs?: number,
  nowMs: number = Date.now(),
): void {
  const fingerprint = keyFingerprint(key);
  const untilMs = nowMs + cooldownMsFor(kind, retryAfterMs);
  poolState(poolId).set(fingerprint, { fingerprint, kind, untilMs });
  persist();
}

/** Clear a key's cooldown. Called on every success — recovery is immediate. */
export function clearKeyCooldown(poolId: KeyPoolId, key: string): void {
  const pool = poolState(poolId);
  if (pool.delete(keyFingerprint(key))) {
    persist();
  }
}

/** Remaining cooldown for a key in ms, or 0 when it is available. */
export function keyCooldownRemainingMs(
  poolId: KeyPoolId,
  key: string,
  nowMs: number = Date.now(),
): number {
  const entry = poolState(poolId).get(keyFingerprint(key));
  if (!entry) return 0;
  return entry.untilMs > nowMs ? entry.untilMs - nowMs : 0;
}

/**
 * Order a pool for this attempt: available keys in configured order, then the
 * cooling ones by soonest expiry.
 *
 * The cooling keys are appended rather than dropped on purpose. If every key is
 * in cooldown, the alternative is to fail without sending anything — which
 * would turn a wrong classification, or a provider that reset earlier than it
 * said, into a hard stop. Trying the nearest-to-expiry key preserves today's
 * "always attempt" semantics: the worst case is the single doomed request the
 * single-key path would also have sent.
 */
export function orderPoolForAttempt(
  poolId: KeyPoolId,
  keys: string[],
  nowMs: number = Date.now(),
): string[] {
  const available: string[] = [];
  const cooling: Array<{ key: string; remaining: number }> = [];
  for (const key of keys) {
    const remaining = keyCooldownRemainingMs(poolId, key, nowMs);
    if (remaining === 0) available.push(key);
    else cooling.push({ key, remaining });
  }
  if (available.length > 0) return available;

  // Every key is cooling: send exactly ONE probe, at the key closest to
  // recovering. Sweeping the rest costs a doomed request each AND re-cools
  // every key it touches — a pool seconds from recovery would be pushed out to
  // a fresh `quota_exhausted` window by the act of discovering it is spent.
  cooling.sort((a, b) => a.remaining - b.remaining);
  return cooling.length > 0 ? [cooling[0].key] : [];
}

/**
 * The pool to run a request against, given a resolved provider config.
 *
 * `resolveXConfig` always populates `apiKeys`, but the config type is also
 * satisfied by a hand-built literal — the field compressor passes one carrying
 * only `apiKey` and `apiUrl`. Falling back to the single key keeps that path on
 * the credential it actually supplied, instead of rotating over an empty pool
 * and sending an empty bearer token.
 */
export function resolvePoolKeys(config: { apiKey?: string; apiKeys?: string[] }): string[] {
  if (Array.isArray(config.apiKeys) && config.apiKeys.length > 0) return config.apiKeys;
  return config.apiKey ? [config.apiKey] : [];
}

/** What `withKeyPool` tells the body about the key it is running with. */
export interface KeyPoolAttempt {
  key: string;
  /** 1-based position in this attempt's order, for logs. */
  attempt: number;
  /** How many keys this sweep may try. */
  poolSize: number;
}

/**
 * Run `body` against the pool, rotating on the three key-fatal kinds.
 *
 * A pool of 0 or 1 keys runs the body exactly once and records nothing — the
 * single-key path stays as it was, cooldown file untouched. With more, each
 * rotate-worthy failure marks its key and moves on; anything else propagates
 * immediately, since a `transient` failure or a malformed-response bug is not
 * the key's fault and `withRetry` has already had its turn.
 *
 * The sweep covers the keys that are actually available. When none are, it
 * sends a single probe at the key nearest to recovering rather than failing
 * blind — a misclassification, or an endpoint that reset earlier than it
 * announced, must not become a hard stop.
 *
 * When every key is spent, the LAST classified error is rethrown unchanged.
 * That matters: `quota_exhausted` still reaches the quota breaker and
 * `rate_limit` still reaches the pause path, so a fully-spent pool behaves
 * exactly like today's single spent key rather than surfacing a new error type
 * the callers upstream do not handle.
 */
export async function withKeyPool<T>(
  opts: { poolId: KeyPoolId; keys: string[]; label?: string },
  body: (attempt: KeyPoolAttempt) => Promise<T>,
): Promise<T> {
  const { poolId, label } = opts;
  // Tolerate a caller that never resolved a pool. A config literal built by
  // hand — the field compressor does exactly this — carries `apiKey` without
  // `apiKeys`, and this wrapper sits outside every request: throwing here would
  // cancel the call before it is sent, which reads downstream as a silent
  // quality regression rather than an error.
  const keys = Array.isArray(opts.keys) ? opts.keys : [];

  if (keys.length <= 1) {
    return body({ key: keys[0] ?? '', attempt: 1, poolSize: keys.length });
  }

  const ordered = orderPoolForAttempt(poolId, keys);
  let lastRotateError: unknown;

  for (let index = 0; index < ordered.length; index++) {
    const key = ordered[index];
    try {
      const result = await body({ key, attempt: index + 1, poolSize: ordered.length });
      clearKeyCooldown(poolId, key);
      return result;
    } catch (err) {
      if (!shouldRotateKey(err)) throw err;
      lastRotateError = err;
      const classified = asClassified(err);
      const kind = classified?.kind ?? 'rate_limit';
      const retryAfterMs = classified?.retryAfterMs;
      markKeyCooldown(poolId, key, kind, retryAfterMs);
      const remaining = ordered.length - index - 1;
      logger.warn(
        'SDK',
        remaining > 0
          ? `${label ?? poolId} key ${index + 1}/${ordered.length} hit ${kind}; rotating to the next key`
          : `${label ?? poolId} key ${index + 1}/${ordered.length} hit ${kind}; no keys left in the pool`,
        {
          poolId,
          keyFingerprint: keyFingerprint(key),
          kind,
          keysRemaining: remaining,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
  }

  throw lastRotateError ?? new Error(`${label ?? poolId} key pool exhausted without an attempt`);
}

/**
 * Test seam: forget everything, in process AND on disk.
 *
 * The persisted file has to go too. Clearing only the in-memory map would
 * re-hydrate the previous test's windows on the next call — which is the
 * persistence working correctly, and exactly the cross-test leak a reset is
 * supposed to prevent.
 */
export function resetKeyPoolStateForTesting(): void {
  cooldowns = new Map();
  salt = null;
  hydrated = false;
  try {
    const filePath = cooldownFilePath();
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // A reset that cannot delete the file is not worth failing a test over.
  }
}
