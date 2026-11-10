import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveTelemetryConsent,
  explainTelemetryConsent,
  loadTelemetryConfig,
  saveTelemetryConfig,
  getOrCreateInstallId,
  type TelemetryConfig,
} from '../../src/services/telemetry/consent';

const enabledConfig: TelemetryConfig = {
  enabled: true,
  installId: '00000000-0000-4000-8000-000000000000',
  decidedAt: '2026-06-09T00:00:00.000Z',
};

const disabledConfig: TelemetryConfig = {
  enabled: false,
  installId: '00000000-0000-4000-8000-000000000001',
  decidedAt: '2026-06-09T00:00:00.000Z',
};

describe('telemetry consent precedence', () => {
  const undecided: TelemetryConfig = {
    installId: '00000000-0000-4000-8000-000000000002',
    decidedAt: '',
  };
  const cases: Array<[NodeJS.ProcessEnv, TelemetryConfig | null, boolean, string]> = [
    [{}, null, true, 'default'],
    [{}, undecided, true, 'default'],
    [{ DO_NOT_TRACK: '1' }, enabledConfig, false, 'DO_NOT_TRACK'],
    [{ DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '1' }, enabledConfig, false, 'DO_NOT_TRACK'],
    [{ DO_NOT_TRACK: 'true' }, enabledConfig, false, 'DO_NOT_TRACK'],
    [{ DO_NOT_TRACK: 'yes' }, enabledConfig, false, 'DO_NOT_TRACK'],
    [{ DO_NOT_TRACK: 'anything' }, enabledConfig, false, 'DO_NOT_TRACK'],
    [{ DO_NOT_TRACK: '0' }, enabledConfig, true, 'config'],
    [{ DO_NOT_TRACK: 'false' }, enabledConfig, true, 'config'],
    [{ DO_NOT_TRACK: '' }, enabledConfig, true, 'config'],
    [{ DO_NOT_TRACK: '' }, disabledConfig, false, 'config'],
    [{ CLAUDE_MEM_TELEMETRY: '0' }, enabledConfig, false, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'false' }, enabledConfig, false, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'off' }, enabledConfig, false, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'OFF' }, enabledConfig, false, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: '1' }, null, true, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'true' }, null, true, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'on' }, null, true, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'ON' }, null, true, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: '1' }, disabledConfig, true, 'env'],
    [{ CLAUDE_MEM_TELEMETRY: 'maybe' }, disabledConfig, false, 'config'],
    [{ CLAUDE_MEM_TELEMETRY: 'maybe' }, null, true, 'default'],
    [{}, enabledConfig, true, 'config'],
    [{}, disabledConfig, false, 'config'],
  ];

  it.each(cases)('resolves %j with config %j to enabled=%s from %s', (env, config, enabled, source) => {
    const explanation = explainTelemetryConsent(env, config);
    expect(explanation).toEqual({ enabled, source });
    expect(resolveTelemetryConsent(env, config)).toBe(explanation.enabled);
  });
});

describe('telemetry config persistence', () => {
  let tempDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `telemetry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadTelemetryConfig', () => {
    it('returns null when telemetry.json does not exist', () => {
      expect(loadTelemetryConfig()).toBeNull();
    });

    it('returns null for corrupt JSON without throwing', () => {
      writeFileSync(join(tempDir, 'telemetry.json'), 'not valid json {{{');

      expect(loadTelemetryConfig()).toBeNull();
    });

    it('returns null for malformed shapes', () => {
      writeFileSync(
        join(tempDir, 'telemetry.json'),
        JSON.stringify({ enabled: 'yes', installId: 'abc' })
      );
      expect(loadTelemetryConfig()).toBeNull();

      writeFileSync(join(tempDir, 'telemetry.json'), JSON.stringify([1, 2, 3]));
      expect(loadTelemetryConfig()).toBeNull();
    });

    it('loads an installId-only config with enabled left undecided', () => {
      writeFileSync(join(tempDir, 'telemetry.json'), JSON.stringify({ installId: 'abc' }));

      const config = loadTelemetryConfig();
      expect(config?.installId).toBe('abc');
      expect(config?.enabled).toBeUndefined();
    });

    it('round-trips a saved config', () => {
      saveTelemetryConfig(enabledConfig);

      expect(loadTelemetryConfig()).toEqual(enabledConfig);
    });
  });

  describe('saveTelemetryConfig', () => {
    it('creates the data dir if missing', () => {
      const nestedDir = join(tempDir, 'nested', 'data-dir');
      process.env.CLAUDE_MEM_DATA_DIR = nestedDir;

      saveTelemetryConfig(disabledConfig);

      expect(existsSync(join(nestedDir, 'telemetry.json'))).toBe(true);
    });
  });

  describe('getOrCreateInstallId', () => {
    it('generates a UUID and persists it WITHOUT recording a consent decision', () => {
      const id = getOrCreateInstallId();

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const config = loadTelemetryConfig();
      expect(config?.installId).toBe(id);
      expect(config?.enabled).toBeUndefined();
      // The opt-out default must survive the ID bootstrap.
      expect(explainTelemetryConsent({}, config)).toEqual({ enabled: true, source: 'default' });
    });

    it('returns the existing install ID on subsequent calls', () => {
      const first = getOrCreateInstallId();
      const second = getOrCreateInstallId();

      expect(second).toBe(first);
    });

    it('preserves enabled state from an existing config', () => {
      saveTelemetryConfig(enabledConfig);

      const id = getOrCreateInstallId();

      expect(id).toBe(enabledConfig.installId);
      expect(loadTelemetryConfig()?.enabled).toBe(true);
    });
  });
});
