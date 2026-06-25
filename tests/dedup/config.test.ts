import { describe, it, expect, afterEach } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const DEDUP_KEYS = [
  'CLAUDE_MEM_DEDUP_ENABLED',
  'CLAUDE_MEM_DEDUP_COSINE_THRESHOLD',
  'CLAUDE_MEM_DEDUP_IDF_VETO_DF',
  'CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS',
  'CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS',
  'CLAUDE_MEM_DEDUP_MAX_SCAN',
] as const;

// Env isolation (lesson from #3056/#3058): never leak DEDUP overrides across tests.
const saved: Record<string, string | undefined> = {};
for (const k of DEDUP_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of DEDUP_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('dedup settings defaults', () => {
  it('ships all DEDUP keys with the researched defaults (off by default)', () => {
    for (const k of DEDUP_KEYS) delete process.env[k];
    const d = SettingsDefaultsManager.getAllDefaults() as Record<string, string>;
    expect(d.CLAUDE_MEM_DEDUP_ENABLED).toBe('false');
    expect(d.CLAUDE_MEM_DEDUP_COSINE_THRESHOLD).toBe('0.80');
    expect(d.CLAUDE_MEM_DEDUP_IDF_VETO_DF).toBe('10');
    expect(d.CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS).toBe('2');
    expect(d.CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS).toBe('10');
    expect(d.CLAUDE_MEM_DEDUP_MAX_SCAN).toBe('2000');
  });

  it('is disabled by default via getBool', () => {
    delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
    expect(SettingsDefaultsManager.getBool('CLAUDE_MEM_DEDUP_ENABLED' as never)).toBe(false);
  });

  it('parses integer knobs via getInt', () => {
    delete process.env.CLAUDE_MEM_DEDUP_IDF_VETO_DF;
    expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_DEDUP_IDF_VETO_DF' as never)).toBe(10);
    expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS' as never)).toBe(10);
  });

  it('parses the cosine threshold as a float from get()', () => {
    delete process.env.CLAUDE_MEM_DEDUP_COSINE_THRESHOLD;
    expect(Number(SettingsDefaultsManager.get('CLAUDE_MEM_DEDUP_COSINE_THRESHOLD' as never))).toBeCloseTo(0.8, 5);
  });

  it('honors env overrides', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    process.env.CLAUDE_MEM_DEDUP_COSINE_THRESHOLD = '0.85';
    expect(SettingsDefaultsManager.getBool('CLAUDE_MEM_DEDUP_ENABLED' as never)).toBe(true);
    expect(Number(SettingsDefaultsManager.get('CLAUDE_MEM_DEDUP_COSINE_THRESHOLD' as never))).toBeCloseTo(0.85, 5);
  });
});
