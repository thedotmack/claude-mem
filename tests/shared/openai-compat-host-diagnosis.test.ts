import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import * as hostConfig from '../../src/shared/opencode-host-config.js';
import {
  diagnoseHostModel,
  HOST_MODEL_STATUS_WORDS,
  type HostModelDiagnostic,
} from '../../src/shared/openai-compat-host-diagnosis.js';

/**
 * The shared host-model diagnosis is the single place that reads the host's
 * OpenCode config for a person-facing line: doctor prints it and the worker
 * turns its translated ids into the observer's model. These tests drive a
 * temporary explicit config so no real machine config is ever read.
 */
const ENV_KEYS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME'] as const;
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

let savedEnv: Record<string, string | undefined>;
let root: string;
let configPath: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), 'host-model-diagnosis-'));
  mkdirSync(join(root, 'opencode'), { recursive: true });
  configPath = join(root, 'host.json');
  process.env.OPENCODE_CONFIG = configPath;
  process.env.OPENCODE_CONFIG_DIR = join(root, 'opencode');
  process.env.XDG_CONFIG_HOME = root;
});

afterEach(() => {
  mock.restore();
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  rmSync(root, { recursive: true, force: true });
});

const settingsFor = (gate: string, explicit = ''): SettingsDefaults => ({
  ...SettingsDefaultsManager.getAllDefaults(),
  CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST: gate,
  CLAUDE_MEM_OPENAI_COMPAT_MODEL: explicit,
});

const writeHost = (value: unknown): void => writeFileSync(configPath, JSON.stringify(value));

describe('diagnoseHostModel', () => {
  it('diagnosis-off: gate off never reads the host config', () => {
    writeHost({ model: 'host/main' });
    const read = spyOn(hostConfig, 'readOpenCodeHostConfig');

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('false'),
      fallbackModel: 'fallback-model',
    });

    expect(diagnostic.status).toBe('off');
    expect(diagnostic.line).toContain('host model: off');
    expect(read).not.toHaveBeenCalled();
  });

  it('diagnosis-none: no host model names the real fallback', () => {
    writeHost({});

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: 'fallback-model',
    });

    expect(diagnostic.status).toBe('none');
    expect(diagnostic.endpointId).toBeUndefined();
    expect(diagnostic.line).toContain('fallback-model');
  });

  it('diagnosis-masked: an explicit model hides the host id and names the setting', () => {
    writeHost({ model: 'host/main' });

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('true', 'pinned'),
      fallbackModel: 'fallback-model',
    });

    expect(diagnostic.status).toBe('masked');
    expect(diagnostic.hostId).toBe('host/main');
    expect(diagnostic.line).toContain('CLAUDE_MEM_OPENAI_COMPAT_MODEL');
    expect(diagnostic.line).toContain('host/main');
  });

  it('diagnosis-resolved: line carries the endpoint id and the provenance of sources.model', () => {
    writeHost({
      model: 'host/main',
      agents: { title: { model: 'host/small' } },
      provider: { host: { models: { main: { modelID: 'endpoint-main' }, small: { modelID: 'endpoint-small' } } } },
    });

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: 'preset-model',
      apiUrl: NVIDIA_URL,
    });

    expect(diagnostic.status).toBe('resolved');
    expect(diagnostic.endpointId).toBe('endpoint-main');
    expect(diagnostic.summaryId).toBe('endpoint-small');
    expect(diagnostic.source).toEqual({ kind: 'explicit', path: configPath });
    expect(diagnostic.line).toContain('endpoint-main');
    expect(diagnostic.line).toContain(hostConfig.HOST_CONFIG_SOURCE_LABELS.explicit);
    expect(diagnostic.line).toContain(configPath);
  });

  it('diagnosis-identity: an endpoint-ready host key keeps the translated id and small model', () => {
    writeHost({
      model: 'hy4/hy4-flash-free',
      agents: { title: { model: 'hy4/small-builtin' } },
      provider: {
        hy4: {
          baseURL: 'https://integrate.api.nvidia.com/v1',
          models: { 'small-builtin': { modelID: 'endpoint-small' } },
        },
      },
    });

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: 'preset-model',
      apiUrl: NVIDIA_URL,
    });

    expect(diagnostic.status).toBe('identity');
    expect(diagnostic.endpointId).toBe('hy4-flash-free');
    expect(diagnostic.summaryId).toBe('endpoint-small');
    expect(diagnostic.line).toContain('hy4-flash-free');
    expect(diagnostic.line).toContain(configPath);
  });

  it('diagnosis-unmapped: line names the host id and the fallback actually in use', () => {
    writeHost({ model: 'ghost/ghost-model' });

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: 'real-fallback',
      apiUrl: NVIDIA_URL,
    });

    expect(diagnostic.status).toBe('unmapped');
    expect(diagnostic.hostId).toBe('ghost/ghost-model');
    expect(diagnostic.endpointId).toBeUndefined();
    expect(diagnostic.line).toContain('ghost/ghost-model');
    expect(diagnostic.line).toContain('real-fallback');
  });

  it('diagnosis-refused: a translated id the endpoint refused falls back too', () => {
    writeHost({
      model: 'host/main',
      provider: { host: { models: { main: { modelID: 'endpoint-main' } } } },
    });

    const diagnostic = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: 'real-fallback',
      apiUrl: NVIDIA_URL,
      isRefused: id => id === 'endpoint-main',
    });

    expect(diagnostic.status).toBe('unmapped');
    expect(diagnostic.endpointId).toBeUndefined();
    expect(diagnostic.line).toContain('real-fallback');
  });

  it('refused-explicit-model-falls-back-to-usable-host: the host id is no longer masked', () => {
    writeHost({
      model: 'host/main',
      provider: { host: { models: { main: { modelID: 'endpoint-main' } } } },
    });
    const settings = settingsFor('true', 'refused-explicit');

    const diagnostic = diagnoseHostModel({
      settings,
      fallbackModel: 'preset-model',
      apiUrl: NVIDIA_URL,
      isRefused: id => id === 'refused-explicit',
    });

    expect(diagnostic.status).toBe('resolved');
    expect(diagnostic.endpointId).toBe('endpoint-main');
    expect(diagnostic.line).not.toContain('hides');
    expect(diagnostic.line).toContain('refused-explicit');
    expect(diagnostic.line).toContain('endpoint-main');
  });

  it('masked-explicit-model-still-hides-host: a usable explicit id keeps the old behavior', () => {
    writeHost({
      model: 'host/main',
      provider: { host: { models: { main: { modelID: 'endpoint-main' } } } },
    });
    const settings = settingsFor('true', 'usable-explicit');

    const diagnostic = diagnoseHostModel({
      settings,
      fallbackModel: 'preset-model',
      apiUrl: NVIDIA_URL,
      isRefused: id => id === 'refused-explicit',
    });

    expect(diagnostic.status).toBe('masked');
    expect(diagnostic.endpointId).toBeUndefined();
    expect(diagnostic.line).toContain('usable-explicit');
    expect(diagnostic.line).toContain('hides the host model');
  });

  it('none-is-not-a-refusal: a disabled default produces neutral wording', () => {
    writeHost({});

    const disabled = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: '',
      fallbackReason: 'none',
    });

    expect(disabled.status).toBe('none');
    expect(disabled.line).toContain('no model');
    expect(disabled.line).not.toContain('refused');

    // A real exhaustion of every candidate keeps the endpoint-blaming wording.
    const refused = diagnoseHostModel({
      settings: settingsFor('true'),
      fallbackModel: '',
      fallbackReason: 'refused',
    });
    expect(refused.line).toContain('refused every fallback');
  });

  it('words the whole status union once', () => {
    // No status list is restated here: the Record is the definition. Adding a
    // status to the union must make its declaration fail the typecheck.
    for (const [status, words] of Object.entries(HOST_MODEL_STATUS_WORDS)) {
      expect(words.label).toContain(`host model: ${status}`);
      expect(['ok', 'warn']).toContain(words.check);
    }
    const diagnostic: HostModelDiagnostic = {
      status: 'off',
      line: HOST_MODEL_STATUS_WORDS.off.label,
    };
    expect(diagnostic.line).toContain('host model: off');
  });
});
