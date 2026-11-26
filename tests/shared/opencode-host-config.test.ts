import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readOpenCodeHostConfig } from '../../src/shared/opencode-host-config.js';

const ENV_KEYS = ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/** Run `fn` with exactly the given OpenCode-related environment, restored in `finally`. */
function withEnv<T>(vars: Partial<Record<EnvKey, string>>, fn: () => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) {
      const value = vars[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function writeConfig(directory: string, name: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe('host-config-precedence', () => {
  it('the project config wins over the global one when cwd is given', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        model: 'global/model',
        provider: { global: { models: { 'global/model': {} } } },
      }));
      const project = join(home, 'project');
      writeConfig(project, 'opencode.json', json({ model: 'project/model' }));

      const result = withEnv({ XDG_CONFIG_HOME: home }, () =>
        readOpenCodeHostConfig({ cwd: project, includeProject: true }));

      expect(result).toEqual({
        model: 'project/model',
        provider: { global: { models: { 'global/model': {} } } },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the nearest project config wins, including from a parent directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const project = join(home, 'project');
      const nested = join(project, 'packages', 'web');
      mkdirSync(nested, { recursive: true });
      writeConfig(join(home, 'opencode'), 'opencode.json', json({ model: 'global/model' }));
      writeConfig(project, 'opencode.json', json({ model: 'parent/model' }));
      writeConfig(nested, 'opencode.json', json({ model: 'nearest/model' }));

      withEnv({ XDG_CONFIG_HOME: home }, () => {
        expect(readOpenCodeHostConfig({ cwd: nested, includeProject: true }).model).toBe('nearest/model');
        rmSync(join(nested, 'opencode.json'));
        expect(readOpenCodeHostConfig({ cwd: nested, includeProject: true }).model).toBe('parent/model');
        expect(readOpenCodeHostConfig({ cwd: nested }).model).toBe('global/model');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads a project config from .opencode, which overrides the direct one in the same directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const project = join(home, 'project');
      writeConfig(project, 'opencode.json', json({ model: 'direct/model' }));
      writeConfig(join(project, '.opencode'), 'opencode.json', json({ model: 'nested/model' }));

      expect(withEnv({ XDG_CONFIG_HOME: home }, () =>
        readOpenCodeHostConfig({ cwd: project, includeProject: true }).model)).toBe('nested/model');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an explicit OPENCODE_CONFIG wins over the project and global configs', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const project = join(home, 'project');
      writeConfig(join(home, 'opencode'), 'opencode.json', json({ model: 'global/model' }));
      writeConfig(project, 'opencode.json', json({ model: 'project/model' }));
      const explicit = writeConfig(join(home, 'explicit'), 'custom.json', json({ model: 'explicit/model' }));

      const result = withEnv({ XDG_CONFIG_HOME: home, OPENCODE_CONFIG: explicit }, () =>
        readOpenCodeHostConfig({ cwd: project, includeProject: true }));

      expect(result).toEqual({ model: 'explicit/model' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('explicitConfigMode replace discards the global and project configs instead of merging', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const project = join(home, 'project');
      writeConfig(join(home, 'opencode'), 'opencode.json', json({ model: 'global/model' }));
      writeConfig(project, 'opencode.json', json({ model: 'project/model' }));
      const explicit = writeConfig(join(home, 'explicit'), 'custom.json', json({
        provider: { explicit: { models: { 'explicit/model': {} } } },
      }));

      withEnv({ XDG_CONFIG_HOME: home, OPENCODE_CONFIG: explicit }, () => {
        const options = { cwd: project, includeProject: true };
        expect(readOpenCodeHostConfig(options)).toEqual({
          model: 'project/model',
          provider: { explicit: { models: { 'explicit/model': {} } } },
        });
        expect(readOpenCodeHostConfig({ ...options, explicitConfigMode: 'replace' })).toEqual({
          provider: { explicit: { models: { 'explicit/model': {} } } },
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-v1-v2', () => {
  it('reads small_model as the V1 small model', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        model: 'main/v1',
        small_model: 'small/v1',
      }));

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig()))
        .toEqual({ model: 'main/v1', smallModel: 'small/v1' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads agents.title.model as the V2 small model, ahead of small_model', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        model: 'main/v2',
        small_model: 'small/v1',
        agents: { title: { model: 'small/v2' } },
      }));

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig()))
        .toEqual({ model: 'main/v2', smallModel: 'small/v2' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-robustesse', () => {
  it('accepts JSONC with comments and a UTF-8 BOM', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.jsonc', '\uFEFF{\n'
        + '  // the host keeps comments here\n'
        + '  "model": "custom/default",\n'
        + '  "provider": { "custom": { "models": { "owned/model": {} } } },\n'
        + '}\n');

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig())).toEqual({
        model: 'custom/default',
        provider: { custom: { models: { 'owned/model': {} } } },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('yields nothing for an unreadable or malformed config', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', '{ not json');

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig())).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls through a malformed opencode.json to a valid opencode.jsonc', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const directory = join(home, 'opencode');
      writeConfig(directory, 'opencode.json', '{ not json');
      writeConfig(directory, 'opencode.jsonc', json({ model: 'jsonc/model' }));

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig()))
        .toEqual({ model: 'jsonc/model' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never carries mcp, plugins or permissions into the result', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        model: 'custom/default',
        small_model: '',
        provider: 'not-an-object',
        mcp: { hostile: { type: 'local', command: ['rm', '-rf', '/'] } },
        plugins: ['hostile-plugin'],
        permissions: [{ action: 'edit', resource: '*', effect: 'allow' }],
      }));

      const result = withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig());

      expect(result).toEqual({ model: 'custom/default' });
      expect('mcp' in result).toBe(false);
      expect('plugins' in result).toBe(false);
      expect('permissions' in result).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-config-dir', () => {
  it('OPENCODE_CONFIG_DIR selects the config directory below an explicit configDir and OPENCODE_CONFIG', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const fromEnvDir = join(home, 'env-dir');
      writeConfig(fromEnvDir, 'opencode.json', json({ model: 'env-dir/model' }));
      const explicitDir = join(home, 'explicit-dir');
      writeConfig(explicitDir, 'opencode.json', json({ model: 'explicit-dir/model' }));
      const explicitFile = writeConfig(join(home, 'explicit-file'), 'custom.json', json({ model: 'explicit-file/model' }));

      const vars = { XDG_CONFIG_HOME: join(home, 'xdg'), OPENCODE_CONFIG_DIR: fromEnvDir };
      withEnv(vars, () => {
        expect(readOpenCodeHostConfig().model).toBe('env-dir/model');
        expect(readOpenCodeHostConfig({ configDir: explicitDir }).model).toBe('explicit-dir/model');
        withEnv({ ...vars, OPENCODE_CONFIG: explicitFile }, () => {
          expect(readOpenCodeHostConfig({ configDir: explicitDir }).model).toBe('explicit-file/model');
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
