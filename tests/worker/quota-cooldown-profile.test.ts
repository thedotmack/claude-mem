import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  tryAdmitQuotaProbe,
  recordQuotaExhausted,
  getQuotaCooldown,
  resetQuotaCooldownsForTesting,
  setClaudeProfileResolverForTesting,
  QUOTA_COOLDOWN_FILENAME,
} from '../../src/shared/quota-cooldown.js';
import {
  isObserverQuotaCooldownActive,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
} from '../../src/shared/observer-health.js';
import { paths } from '../../src/shared/paths.js';

// Quota is per Claude account, and CLAUDE_MEM_CLAUDE_CONFIG_DIR can move the
// observer to another account between spawns. A 'claude' breaker armed while
// billing one profile must not pause capture for a different one.
describe('quota cooldown breaker — per-account claude profile', () => {
  let currentProfile = 'work';
  const ledgerPath = () => join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    currentProfile = 'work';
    setClaudeProfileResolverForTesting(() => currentProfile);
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('records the profile that armed a claude breaker', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    expect(getQuotaCooldown('claude')?.profile).toBe('work');
  });

  it('keeps withholding requests while the same profile is selected', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: false, claimId: null });
  });

  it('drops a breaker armed under another profile and admits the new one', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    currentProfile = 'personal';

    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
    expect(getQuotaCooldown('claude')).toBeNull();
    expect(isObserverQuotaCooldownActive(readObserverHealth(join(paths.dataDir(), OBSERVER_HEALTH_FILENAME)))).toBe(false);
  });

  it('re-arms for the new profile if it is exhausted too', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');
    currentProfile = 'personal';
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(true);

    recordQuotaExhausted('claude', 'Weekly limit reached');
    expect(getQuotaCooldown('claude')?.profile).toBe('personal');
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
  });

  it('does not scope non-claude providers by profile', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached');
    currentProfile = 'personal';

    expect(getQuotaCooldown('gemini')?.profile).toBeUndefined();
    expect(tryAdmitQuotaProbe('gemini').admitted).toBe(false);
  });

  it('persists the profile across a restart', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    const ledger = readFileSync(ledgerPath(), 'utf-8');
    expect(JSON.parse(ledger)[0].profile).toBe('work');

    // Simulate a fresh process reading the ledger the previous one wrote.
    resetQuotaCooldownsForTesting();
    setClaudeProfileResolverForTesting(() => currentProfile);
    writeFileSync(ledgerPath(), ledger, 'utf-8');

    expect(getQuotaCooldown('claude')?.profile).toBe('work');
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
  });

  it('treats a persisted claude breaker without a profile as another account\'s', () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify([
      { provider: 'claude', message: 'Weekly limit reached', window: 'seven_day', armedAtMs: Date.now() },
    ]), 'utf-8');

    expect(getQuotaCooldown('claude')?.profile).toBeUndefined();
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
    expect(getQuotaCooldown('claude')).toBeNull();
  });
});
