import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTrialReadySettings,
  parseTrialReadyBody,
} from '../../src/npx-cli/commands/install';
import {
  CMEM_PRO_BASE_URL,
  CMEM_PRO_MODEL,
} from '../../src/npx-cli/cmem-pro-costs';

const repoRoot = process.cwd();
const decoder = new TextDecoder();

function runCompletedPairingChild(body: Record<string, unknown>): {
  output: string;
  settings: Record<string, string>;
  settingsMode: number;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-installer-contract-'));
  try {
    const script = `
      globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const { completeTrialPairing } = await import('./src/npx-cli/commands/install.ts');
      const result = await completeTrialPairing({
        pairingId: 'PAIRING_ID_MUST_NOT_LEAK',
        secret: 'PAIRING_SECRET_MUST_NOT_LEAK',
        pollIntervalMs: 1,
        userCode: null,
      }, 'test-version');
      console.log('__PAIRING_RESULT__=' + JSON.stringify({ plan: result?.plan, ready: result !== null }));
    `;
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_TELEMETRY: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
    expect(result.exitCode, output).toBe(0);
    return {
      output,
      settings: JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8')),
      settingsMode: statSync(join(dataDir, 'settings.json')).mode & 0o777,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('installer trial-ready contract', () => {
  it('normalizes the current poll response without changing delivered credentials', () => {
    const ready = parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
      memory_key: 'cm_pro_memory_secret',
      memory_base_url: 'https://cmem.ai/api/inference/v1',
      memory_model: 'cmem-observer-v2',
      plan: 'pro',
      trial: { ends_at: '2026-09-02T12:00:00.000Z' },
    });

    expect(ready).toEqual({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memoryKey: 'cm_pro_memory_secret',
      memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
      memoryModel: 'cmem-observer-v2',
      plan: 'pro',
      trialEndsAt: '2026-09-02T12:00:00.000Z',
    });
  });

  it('supports the legacy response by using the setup token and gateway defaults', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'legacy_user',
      setup_token: 'legacy_one_shot_token',
      hub_url: 'https://legacy-sync.cmem.ai',
    })).toEqual({
      userId: 'legacy_user',
      setupToken: 'legacy_one_shot_token',
      hubUrl: 'https://legacy-sync.cmem.ai',
      memoryKey: 'legacy_one_shot_token',
      memoryBaseUrl: CMEM_PRO_BASE_URL,
      memoryModel: CMEM_PRO_MODEL,
      plan: 'trial',
      trialEndsAt: null,
    });
  });

  it('rejects malformed and non-ready poll responses', () => {
    expect(parseTrialReadyBody(null)).toBeNull();
    expect(parseTrialReadyBody({ status: 'pending' })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 123,
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
    })).toBeNull();
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: '   ',
      hub_url: 'https://sync.cmem.ai',
    })).toBeNull();
  });

  it('falls back safely for optional fields from a partially upgraded server', () => {
    expect(parseTrialReadyBody({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'setup_secret',
      hub_url: 'https://sync.cmem.ai',
      memory_key: '',
      memory_base_url: '',
      memory_model: '',
      plan: 'future-plan',
      trial: { ends_at: 123 },
    })).toEqual({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memoryKey: 'setup_secret',
      memoryBaseUrl: CMEM_PRO_BASE_URL,
      memoryModel: CMEM_PRO_MODEL,
      plan: 'trial',
      trialEndsAt: null,
    });
  });

  it('stages one-shot credentials atomically without choosing a provider', () => {
    const settings = buildTrialReadySettings({
      userId: 'user_123',
      setupToken: 'setup_secret',
      hubUrl: 'https://sync.cmem.ai',
      memoryKey: 'cm_pro_memory_secret',
      memoryBaseUrl: 'https://cmem.ai/api/inference/v1',
      memoryModel: 'cmem-observer',
      plan: 'none',
      trialEndsAt: null,
    }, 'test-device');

    expect(settings).toEqual({
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'setup_secret',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user_123',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-device',
      CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
      CLAUDE_MEM_PRO_TRIAL_ENDS_AT: '',
      CLAUDE_MEM_PRO_PLAN: 'none',
      CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_memory_secret',
      CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_PRO_MEMORY_MODEL: 'cmem-observer',
      CLAUDE_MEM_PRO_FALLBACK_AT: '',
    });
    expect(settings).not.toHaveProperty('CLAUDE_MEM_PROVIDER');
    expect(settings).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_API_KEY');
    expect(Object.values(settings).filter((value) => value === 'cm_pro_memory_secret')).toHaveLength(1);
  });

  it('persists the current ready response without printing delivered secrets', () => {
    const { output, settings, settingsMode } = runCompletedPairingChild({
      status: 'ready',
      user_id: 'user_123',
      setup_token: 'SETUP_TOKEN_MUST_NOT_LEAK',
      hub_url: 'https://sync.cmem.ai',
      memory_key: 'MEMORY_KEY_MUST_NOT_LEAK',
      memory_base_url: 'https://cmem.ai/api/inference/v1',
      memory_model: 'cmem-observer',
      plan: 'none',
    });

    expect(output).toContain('__PAIRING_RESULT__={"plan":"none","ready":true}');
    expect(output).not.toContain('PAIRING_ID_MUST_NOT_LEAK');
    expect(output).not.toContain('PAIRING_SECRET_MUST_NOT_LEAK');
    expect(output).not.toContain('SETUP_TOKEN_MUST_NOT_LEAK');
    expect(output).not.toContain('MEMORY_KEY_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('MEMORY_KEY_MUST_NOT_LEAK');
    expect(settings).not.toHaveProperty('CLAUDE_MEM_PROVIDER');
    expect(settings).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_API_KEY');
    expect(settingsMode).toBe(0o600);
  });

  it('persists the legacy ready response with its setup token as the memory credential', () => {
    const { output, settings } = runCompletedPairingChild({
      status: 'ready',
      user_id: 'legacy_user',
      setup_token: 'LEGACY_TOKEN_MUST_NOT_LEAK',
      hub_url: 'https://legacy-sync.cmem.ai',
    });

    expect(output).toContain('__PAIRING_RESULT__={"plan":"trial","ready":true}');
    expect(output).not.toContain('LEGACY_TOKEN_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('LEGACY_TOKEN_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('LEGACY_TOKEN_MUST_NOT_LEAK');
    expect(settings.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe(CMEM_PRO_BASE_URL);
    expect(settings.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe(CMEM_PRO_MODEL);
  });

  it('treats Ctrl+C during polling as skip-sign-in and exits the wait cleanly', () => {
    const script = `
      globalThis.fetch = async () => new Response(JSON.stringify({ stage: 'awaiting_login' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
      const { completeTrialPairing } = await import('./src/npx-cli/commands/install.ts');
      setTimeout(() => process.emit('SIGINT'), 20);
      const result = await completeTrialPairing({
        pairingId: 'PAIRING_ID_MUST_NOT_LEAK',
        secret: 'PAIRING_SECRET_MUST_NOT_LEAK',
        pollIntervalMs: 1000,
        userCode: null,
      }, 'test-version');
      console.log('__CANCEL_RESULT__=' + String(result));
    `;
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);

    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('Ctrl+C skips sign-in and continues installation.');
    expect(output).toContain('__CANCEL_RESULT__=null');
    expect(output).not.toContain('PAIRING_ID_MUST_NOT_LEAK');
    expect(output).not.toContain('PAIRING_SECRET_MUST_NOT_LEAK');
  });
});
