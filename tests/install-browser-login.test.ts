import { describe, expect, it } from 'bun:test';

import { parseTrialReadyBody } from '../src/npx-cli/commands/install.js';

describe('installer browser-login poll contract', () => {
  it('normalizes the new universal-memory-key response', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user-1',
      setup_token: 'sync-token',
      hub_url: 'https://sync.example.test',
      memory_key: 'memory-key',
      memory_base_url: 'https://memory.example.test/v1',
      memory_model: 'cmem-observer-next',
      plan: 'none',
      trial: { ends_at: '2026-09-02T12:00:00.000Z' },
    })).toEqual({
      userId: 'user-1',
      setupToken: 'sync-token',
      hubUrl: 'https://sync.example.test',
      memoryKey: 'memory-key',
      memoryBaseUrl: 'https://memory.example.test/v1',
      memoryModel: 'cmem-observer-next',
      plan: 'none',
      trialEndsAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('keeps the legacy ready response backward compatible', () => {
    const result = parseTrialReadyBody({
      status: 'ready',
      user_id: 'legacy-user',
      setup_token: 'legacy-token',
      hub_url: 'https://sync.example.test',
    });

    expect(result).not.toBeNull();
    expect(result?.memoryKey).toBe('legacy-token');
    expect(result?.plan).toBe('trial');
    expect(result?.trialEndsAt).toBeNull();
    expect(result?.memoryBaseUrl).toContain('/api/inference/v1');
    expect(result?.memoryModel).toBe('cmem-observer');
  });

  it('rejects unsafe delivered memory gateway URLs', () => {
    const ready = {
      status: 'ready',
      user_id: 'user-1',
      setup_token: 'sync-token',
      hub_url: 'https://sync.example.test',
      memory_key: 'memory-key',
      memory_model: 'cmem-observer-next',
      plan: 'none',
    };

    expect(parseTrialReadyBody({
      ...ready,
      memory_base_url: 'http://memory.example.test/v1',
    })).toBeNull();
    expect(parseTrialReadyBody({
      ...ready,
      memory_base_url: 'https://user@memory.example.test/v1',
    })).toBeNull();
  });

  it('rejects incomplete or non-ready poll responses', () => {
    expect(parseTrialReadyBody({ status: 'pending' })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user-1',
      setup_token: 'sync-token',
    })).toBeNull();
  });

  it('rejects empty credentials and malformed new-contract responses', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: '   ',
      setup_token: 'sync-token',
      hub_url: 'https://sync.example.test',
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user-1',
      setup_token: '',
      hub_url: 'https://sync.example.test',
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user-1',
      setup_token: 'sync-token',
      hub_url: 'https://sync.example.test',
      memory_key: 'memory-key',
      // New-contract responses must carry their actual plan. Falling back to
      // legacy `trial` here would present a false entitlement to the user.
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user-1',
      setup_token: 'sync-token',
      hub_url: 'https://sync.example.test',
      memory_key: '   ',
      plan: 'pro',
    })).toBeNull();
  });
});
