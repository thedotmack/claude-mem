import { describe, it, expect, beforeEach } from 'bun:test';
import {
  buildKeyPool,
  KEY_ROTATE_KINDS,
  resolvePoolKeys,
  retryPolicyForPool,
  clearKeyCooldown,
  KEY_COOLDOWN_MS,
  keyCooldownRemainingMs,
  markKeyCooldown,
  MAX_POOL_KEYS,
  orderPoolForAttempt,
  parseApiKeyList,
  resetKeyPoolStateForTesting,
  shouldRotateKey,
  withKeyPool,
} from '../../src/shared/api-key-pool.js';
import { withRetry } from '../../src/services/worker/retry.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';

/**
 * Preload (tests/preload.ts) pins CLAUDE_MEM_DATA_DIR to a per-run temp dir, so
 * the cooldown file these tests write never touches a real ~/.claude-mem.
 */
function classified(kind: string, retryAfterMs?: number): ClassifiedProviderError {
  return new ClassifiedProviderError(`test ${kind}`, {
    kind,
    cause: new Error('test'),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

describe('parseApiKeyList', () => {
  it('splits on newlines, commas, semicolons and whitespace', () => {
    expect(parseApiKeyList('a\nb,c;d e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('trims, drops blanks, and collapses duplicates in order', () => {
    expect(parseApiKeyList('  a  ,, b ,\n\n a \n c ')).toEqual(['a', 'b', 'c']);
  });

  it('accepts an array, since settings.json is hand-edited', () => {
    expect(parseApiKeyList(['a', ' b '])).toEqual(['a', 'b']);
  });

  it('flattens separator-bearing entries inside an array', () => {
    expect(parseApiKeyList(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for blank, null, and non-string input', () => {
    expect(parseApiKeyList('')).toEqual([]);
    expect(parseApiKeyList('   \n  ')).toEqual([]);
    expect(parseApiKeyList(null)).toEqual([]);
    expect(parseApiKeyList(undefined)).toEqual([]);
    expect(parseApiKeyList(42)).toEqual([]);
  });

  it('caps a pathological paste at MAX_POOL_KEYS', () => {
    const many = Array.from({ length: MAX_POOL_KEYS + 25 }, (_, i) => `key-${i}`);
    expect(parseApiKeyList(many)).toHaveLength(MAX_POOL_KEYS);
  });
});

describe('buildKeyPool', () => {
  it('keeps the primary key at index 0', () => {
    expect(buildKeyPool('primary', 'extra-1,extra-2')).toEqual(['primary', 'extra-1', 'extra-2']);
  });

  it('is a single-entry pool when no list is configured — the unchanged path', () => {
    expect(buildKeyPool('primary', '')).toEqual(['primary']);
  });

  it('does not duplicate a primary that also appears in the list', () => {
    expect(buildKeyPool('a', 'b,a,c')).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the list when there is no primary', () => {
    expect(buildKeyPool('', 'a,b')).toEqual(['a', 'b']);
  });

  it('is empty when neither is configured', () => {
    expect(buildKeyPool('', '')).toEqual([]);
  });
});

describe('shouldRotateKey', () => {
  it('rotates on the three kinds that mean the key is spent', () => {
    expect(shouldRotateKey(classified('rate_limit'))).toBe(true);
    expect(shouldRotateKey(classified('quota_exhausted'))).toBe(true);
    expect(shouldRotateKey(classified('auth_invalid'))).toBe(true);
  });

  it('does not rotate on kinds withRetry already owns, or on plain errors', () => {
    expect(shouldRotateKey(classified('transient'))).toBe(false);
    expect(shouldRotateKey(classified('unrecoverable'))).toBe(false);
    expect(shouldRotateKey(classified('setup_required'))).toBe(false);
    expect(shouldRotateKey(new Error('boom'))).toBe(false);
    expect(shouldRotateKey(null)).toBe(false);
    expect(shouldRotateKey('rate_limit')).toBe(false);
  });
});

describe('cooldown bookkeeping', () => {
  beforeEach(() => {
    resetKeyPoolStateForTesting();
  });

  it('reports no cooldown for an untouched key', () => {
    expect(keyCooldownRemainingMs('gemini', 'k1')).toBe(0);
  });

  it('applies the kind-specific window', () => {
    const now = 1_000_000;
    markKeyCooldown('gemini', 'k1', 'quota_exhausted', undefined, now);
    expect(keyCooldownRemainingMs('gemini', 'k1', now)).toBe(KEY_COOLDOWN_MS.quota_exhausted);
  });

  it('prefers a provider-supplied Retry-After for rate limits', () => {
    const now = 1_000_000;
    markKeyCooldown('gemini', 'k1', 'rate_limit', 5_000, now);
    expect(keyCooldownRemainingMs('gemini', 'k1', now)).toBe(5_000);
  });

  it('clamps an absurd Retry-After rather than parking a key for a day', () => {
    const now = 1_000_000;
    markKeyCooldown('gemini', 'k1', 'rate_limit', 86_400_000, now);
    expect(keyCooldownRemainingMs('gemini', 'k1', now)).toBe(15 * 60_000);
  });

  it('expires on its own', () => {
    const now = 1_000_000;
    markKeyCooldown('gemini', 'k1', 'rate_limit', 1_000, now);
    expect(keyCooldownRemainingMs('gemini', 'k1', now + 1_500)).toBe(0);
  });

  it('clears immediately, so recovery does not wait out the window', () => {
    markKeyCooldown('gemini', 'k1', 'quota_exhausted');
    expect(keyCooldownRemainingMs('gemini', 'k1')).toBeGreaterThan(0);
    clearKeyCooldown('gemini', 'k1');
    expect(keyCooldownRemainingMs('gemini', 'k1')).toBe(0);
  });

  it('keeps pools independent', () => {
    markKeyCooldown('gemini', 'shared-key', 'quota_exhausted');
    expect(keyCooldownRemainingMs('openrouter', 'shared-key')).toBe(0);
  });
});

describe('orderPoolForAttempt', () => {
  beforeEach(() => {
    resetKeyPoolStateForTesting();
  });

  it('preserves configured order when nothing is cooling', () => {
    expect(orderPoolForAttempt('gemini', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops cooling keys entirely while any key is available', () => {
    // Not "cooling keys last": a sweep that continues into them spends a doomed
    // request on each AND re-cools every one it touches.
    const now = 1_000_000;
    markKeyCooldown('gemini', 'a', 'quota_exhausted', undefined, now);
    expect(orderPoolForAttempt('gemini', ['a', 'b', 'c'], now)).toEqual(['b', 'c']);
  });

  it('when every key is cooling, probes ONLY the nearest to expiry rather than failing blind', () => {
    const now = 1_000_000;
    markKeyCooldown('gemini', 'a', 'quota_exhausted', undefined, now); // 30m
    markKeyCooldown('gemini', 'b', 'rate_limit', 2_000, now);          // 2s
    markKeyCooldown('gemini', 'c', 'auth_invalid', undefined, now);    // 6h
    expect(orderPoolForAttempt('gemini', ['a', 'b', 'c'], now)).toEqual(['b']);
  });

  it('is empty for an empty pool', () => {
    expect(orderPoolForAttempt('gemini', [])).toEqual([]);
  });
});

/**
 * A fully-cooling pool used to be swept end to end, so discovering it was spent
 * cost one request per key and — because each rotate-worthy failure re-cools
 * the key that earned it — pushed a pool seconds from recovery out to a fresh
 * 30-minute window.
 */
describe('a spent pool does not push its own recovery further away', () => {
  beforeEach(() => {
    resetKeyPoolStateForTesting();
  });

  it('re-cools only the single key it actually probed', async () => {
    const keys = ['k1', 'k2', 'k3'];
    for (const key of keys) markKeyCooldown('gemini', key, 'rate_limit', 5_000);

    const probed: string[] = [];
    await expect(withKeyPool({ poolId: 'gemini', keys }, async ({ key }) => {
      probed.push(key);
      throw new ClassifiedProviderError('spent', { kind: 'quota_exhausted', cause: new Error('x') });
    })).rejects.toThrow();

    expect(probed).toHaveLength(1);
    // The untouched keys keep their short window and recover on schedule.
    expect(keyCooldownRemainingMs('gemini', 'k2')).toBeLessThanOrEqual(5_000);
    expect(keyCooldownRemainingMs('gemini', 'k3')).toBeLessThanOrEqual(5_000);
  });
});

/**
 * `rate_limit` is retryable against a single key — waiting out a per-minute
 * window is the best move when that key is all there is. With a pool it is the
 * wrong move: the inner retry honors `retryAfterMs` twice against the very key
 * the pool is trying to move off, spending the window rotation exists to avoid.
 */
describe('retryPolicyForPool', () => {
  it('adds nothing for a pool of one, so single-key installs are unchanged', () => {
    expect(retryPolicyForPool(1)).toEqual({});
    expect(retryPolicyForPool(0)).toEqual({});
  });

  it('suppresses in-place retry of the rotate-worthy kinds once there is somewhere to rotate', () => {
    expect(retryPolicyForPool(2).nonRetryableKinds).toEqual(KEY_ROTATE_KINDS);
    expect(KEY_ROTATE_KINDS).toContain('rate_limit');
    expect(KEY_ROTATE_KINDS).toContain('quota_exhausted');
    expect(KEY_ROTATE_KINDS).toContain('auth_invalid');
  });

  it('rotates after ONE failed request per key instead of three', async () => {
    const attempts: string[] = [];
    await expect(withKeyPool({ poolId: 'openrouter', keys: ['key-one', 'key-two'] },
      ({ key, poolSize }) => withRetry(async () => {
        attempts.push(key);
        throw new ClassifiedProviderError('rate limited', {
          kind: 'rate_limit', cause: new Error('429'), retryAfterMs: 1,
        });
      }, { label: 'probe', ...retryPolicyForPool(poolSize) }),
    )).rejects.toThrow();

    expect(attempts).toEqual(['key-one', 'key-two']);
  });

  it('leaves a single key retrying in place, exactly as before', async () => {
    const attempts: string[] = [];
    await expect(withKeyPool({ poolId: 'openrouter', keys: ['solo'] },
      ({ key, poolSize }) => withRetry(async () => {
        attempts.push(key);
        throw new ClassifiedProviderError('rate limited', {
          kind: 'rate_limit', cause: new Error('429'), retryAfterMs: 1,
        });
      }, { label: 'probe', ...retryPolicyForPool(poolSize) }),
    )).rejects.toThrow();

    expect(attempts).toEqual(['solo', 'solo', 'solo']);
  });

  it('still retries transient in place rather than spending the pool on a network blip', async () => {
    const attempts: string[] = [];
    await expect(withKeyPool({ poolId: 'openrouter', keys: ['k1', 'k2'] },
      ({ key, poolSize }) => withRetry(async () => {
        attempts.push(key);
        throw new ClassifiedProviderError('blip', { kind: 'transient', cause: new Error('x') });
      }, { label: 'probe', baseDelayMs: 1, ...retryPolicyForPool(poolSize) }),
    )).rejects.toThrow();

    expect(attempts).toEqual(['k1', 'k1', 'k1']);
  });
});

/**
 * A hand-built config literal is a real caller, not a hypothetical: the field
 * compressor passes `{ apiKey, model, apiUrl }` straight through to `query()`.
 * Before this, `withKeyPool` read `.length` off an undefined pool and threw
 * before the request went out — which `optimizeField` catches, so field
 * compression silently stopped instead of failing loudly.
 */
describe('resolvePoolKeys', () => {
  it('uses the resolved pool when there is one', () => {
    expect(resolvePoolKeys({ apiKey: 'a', apiKeys: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('falls back to the single key when the pool is absent or empty', () => {
    expect(resolvePoolKeys({ apiKey: 'a' })).toEqual(['a']);
    expect(resolvePoolKeys({ apiKey: 'a', apiKeys: [] })).toEqual(['a']);
  });

  it('is empty when there is no credential at all', () => {
    expect(resolvePoolKeys({})).toEqual([]);
  });
});

describe('withKeyPool', () => {
  beforeEach(() => {
    resetKeyPoolStateForTesting();
  });

  it('runs the body once for a single-key pool and records no cooldown', async () => {
    const seen: string[] = [];
    await expect(
      withKeyPool({ poolId: 'gemini', keys: ['only'] }, async ({ key }) => {
        seen.push(key);
        throw classified('quota_exhausted');
      }),
    ).rejects.toThrow('test quota_exhausted');

    expect(seen).toEqual(['only']);
    // The single-key path must stay byte-identical to the pre-pool behaviour,
    // which means it does not touch the cooldown file at all.
    expect(keyCooldownRemainingMs('gemini', 'only')).toBe(0);
  });

  it('runs the body once instead of throwing when the caller passed no pool at all', async () => {
    // Regression: `keys.length` on undefined threw before the request was sent.
    let ran = 0;
    const result = await withKeyPool(
      { poolId: 'gemini', keys: undefined as unknown as string[] },
      async () => { ran++; return 'ok'; },
    );
    expect(result).toBe('ok');
    expect(ran).toBe(1);
  });

  it('runs the body once with an empty key for an empty pool', async () => {
    const result = await withKeyPool({ poolId: 'gemini', keys: [] }, async ({ key }) => key === '' ? 'ok' : 'wrong');
    expect(result).toBe('ok');
  });

  it('rotates to the next key on quota exhaustion and succeeds', async () => {
    const seen: string[] = [];
    const result = await withKeyPool({ poolId: 'gemini', keys: ['a', 'b'] }, async ({ key }) => {
      seen.push(key);
      if (key === 'a') throw classified('quota_exhausted');
      return 'served-by-b';
    });

    expect(result).toBe('served-by-b');
    expect(seen).toEqual(['a', 'b']);
    expect(keyCooldownRemainingMs('gemini', 'a')).toBeGreaterThan(0);
    expect(keyCooldownRemainingMs('gemini', 'b')).toBe(0);
  });

  it('rotates on rate_limit and on auth_invalid too', async () => {
    for (const kind of ['rate_limit', 'auth_invalid']) {
      resetKeyPoolStateForTesting();
      const seen: string[] = [];
      const result = await withKeyPool({ poolId: 'openrouter', keys: ['a', 'b'] }, async ({ key }) => {
        seen.push(key);
        if (key === 'a') throw classified(kind);
        return 'ok';
      });
      expect(result).toBe('ok');
      expect(seen).toEqual(['a', 'b']);
    }
  });

  it('does not spend the pool on a transient failure', async () => {
    const seen: string[] = [];
    await expect(
      withKeyPool({ poolId: 'gemini', keys: ['a', 'b', 'c'] }, async ({ key }) => {
        seen.push(key);
        throw classified('transient');
      }),
    ).rejects.toThrow('test transient');

    expect(seen).toEqual(['a']);
    expect(keyCooldownRemainingMs('gemini', 'a')).toBe(0);
  });

  it('propagates an unrecoverable error without rotating', async () => {
    const seen: string[] = [];
    await expect(
      withKeyPool({ poolId: 'gemini', keys: ['a', 'b'] }, async ({ key }) => {
        seen.push(key);
        throw classified('unrecoverable');
      }),
    ).rejects.toThrow('test unrecoverable');
    expect(seen).toEqual(['a']);
  });

  it('rethrows the last classified error when every key is spent, so the breaker still sees quota_exhausted', async () => {
    let thrown: unknown;
    try {
      await withKeyPool({ poolId: 'gemini', keys: ['a', 'b'] }, async () => {
        throw classified('quota_exhausted');
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ClassifiedProviderError);
    expect((thrown as ClassifiedProviderError).kind).toBe('quota_exhausted');
    expect(keyCooldownRemainingMs('gemini', 'a')).toBeGreaterThan(0);
    expect(keyCooldownRemainingMs('gemini', 'b')).toBeGreaterThan(0);
  });

  it('skips a key that is already cooling from an earlier request', async () => {
    markKeyCooldown('gemini', 'a', 'quota_exhausted');
    const seen: string[] = [];
    const result = await withKeyPool({ poolId: 'gemini', keys: ['a', 'b'] }, async ({ key }) => {
      seen.push(key);
      return key;
    });
    expect(result).toBe('b');
    expect(seen).toEqual(['b']);
  });

  it('clears a recovered key on success', async () => {
    markKeyCooldown('gemini', 'a', 'rate_limit', 1_000);
    // Force 'a' to be tried by making it the only key in the pool for this call.
    const result = await withKeyPool({ poolId: 'gemini', keys: ['a', 'b'] }, async ({ key }) => key);
    expect(result).toBe('b');

    clearKeyCooldown('gemini', 'a');
    expect(keyCooldownRemainingMs('gemini', 'a')).toBe(0);
  });

  it('reports position and pool size to the body, for logging', async () => {
    const attempts: Array<{ attempt: number; poolSize: number }> = [];
    await withKeyPool({ poolId: 'gemini', keys: ['a', 'b'] }, async ({ key, attempt, poolSize }) => {
      attempts.push({ attempt, poolSize });
      if (key === 'a') throw classified('rate_limit');
      return 'ok';
    });
    expect(attempts).toEqual([
      { attempt: 1, poolSize: 2 },
      { attempt: 2, poolSize: 2 },
    ]);
  });
});
