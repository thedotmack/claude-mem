import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_MAX_PAID_SENDS_PER_BATCH,
  paidSendBudgetForClaimedBatch,
  resolveMaxPaidSendsPerBatch,
} from '../../src/services/worker/paid-send-budget.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

// #4737: on a self-hosted endpoint a resend costs nothing, but the fixed
// two-send budget still parks every batch claimed while the endpoint is down
// or stalled. CLAUDE_MEM_MAX_PAID_SENDS lets an operator raise the cap; the
// default stays two ("never pay twice").
let settingsDir: string;
let settingsPath: string;

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'max-paid-sends-'));
  settingsPath = join(settingsDir, 'settings.json');
  writeFileSync(settingsPath, '{}');
});

afterEach(() => {
  rmSync(settingsDir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings));
}

describe('resolveMaxPaidSendsPerBatch', () => {
  it('defaults to the shipped two sends', () => {
    expect(resolveMaxPaidSendsPerBatch({}, settingsPath)).toBe(DEFAULT_MAX_PAID_SENDS_PER_BATCH);
    expect(String(DEFAULT_MAX_PAID_SENDS_PER_BATCH)).toBe(
      SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_MAX_PAID_SENDS,
    );
  });

  it('reads settings.json, and the env var overrides it', () => {
    writeSettings({ CLAUDE_MEM_MAX_PAID_SENDS: '6' });
    expect(resolveMaxPaidSendsPerBatch({}, settingsPath)).toBe(6);
    expect(resolveMaxPaidSendsPerBatch({ CLAUDE_MEM_MAX_PAID_SENDS: '4' }, settingsPath)).toBe(4);
    writeSettings({ CLAUDE_MEM_MAX_PAID_SENDS: 8 });
    expect(resolveMaxPaidSendsPerBatch({}, settingsPath)).toBe(8);
  });

  it('accepts 1..20 and falls back to the default for anything else', () => {
    expect(resolveMaxPaidSendsPerBatch({ CLAUDE_MEM_MAX_PAID_SENDS: '1' }, settingsPath)).toBe(1);
    expect(resolveMaxPaidSendsPerBatch({ CLAUDE_MEM_MAX_PAID_SENDS: '20' }, settingsPath)).toBe(20);
    // Zero would mean unlimited, but the budget also counts output failures, so
    // a model that keeps answering unusably would be resent forever.
    for (const value of ['0', '-1', '21', '2.5', 'abc', '', ' ']) {
      expect(resolveMaxPaidSendsPerBatch({ CLAUDE_MEM_MAX_PAID_SENDS: value }, settingsPath)).toBe(2);
    }
  });
});

describe('paidSendBudgetForClaimedBatch with a configured cap', () => {
  function session(claimedMessageIds: number[]): ActiveSession {
    return { claimedMessageIds } as unknown as ActiveSession;
  }

  it('gives a new batch the configured cap, and that cap decides when it is spent', () => {
    const s = session([7]);
    const budget = paidSendBudgetForClaimedBatch(s, 4)!;
    expect(budget.maxPaidSends).toBe(4);
    for (let i = 0; i < 3; i++) budget.recordPaidSend();
    expect(budget.hasRemainingPaidSend()).toBe(true);
    budget.recordPaidSend();
    expect(budget.hasRemainingPaidSend()).toBe(false);
  });

  it('keeps the cap a batch started with when the setting changes mid-batch', () => {
    const s = session([7]);
    const first = paidSendBudgetForClaimedBatch(s, 4)!;
    expect(paidSendBudgetForClaimedBatch(s, 2)).toBe(first);
    expect(first.maxPaidSends).toBe(4);
  });
});
