import { describe, it, expect, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getOpenCodeHostConfigReadFailures,
  readOpenCodeHostConfig,
  resetOpenCodeHostConfigReadFailuresForTesting,
  systemConfigDirectories,
  type ReadOpenCodeHostConfigOptions,
} from '../../src/shared/opencode-host-config.js';
import { resolveEndpointModelId } from '../../src/shared/opencode-model-id.js';
import { logger } from '../../src/utils/logger.js';

const ENV_KEYS = [
  'XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_PROJECT_CONFIG',
] as const;
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

/** Read with no real machine-wide system dirs, so exact assertions stay hermetic. */
function readHermeticHostConfig(options: ReadOpenCodeHostConfigOptions = {}) {
  return readOpenCodeHostConfig({ ...options, systemConfigDirs: [] });
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
        readHermeticHostConfig({ cwd: project, includeProject: true }));

      expect(result).toEqual({
        model: 'project/model',
        provider: { global: { models: { 'global/model': {} } } },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('host-config-disable-project-flag-is-informational', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const project = join(home, 'project');
      writeConfig(project, 'opencode.json', json({ model: 'project/model' }));

      // Characterization only: claude-mem never reads this flag (OpenCode V2
      // ignores it), so the project model is still returned. withEnv restores
      // the flag in its finally block.
      expect(withEnv({
        XDG_CONFIG_HOME: home,
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      }, () => readHermeticHostConfig({ cwd: project, includeProject: true }).model)).toBe('project/model');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges provider maps by provider id and models by key, with the nearest level winning', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const project = join(home, 'project');
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        provider: {
          a: { models: { x: { modelID: 'global-x' } } },
          both: { models: { x: { modelID: 'global-x' } } },
        },
      }));
      writeConfig(home, 'opencode.json', json({ provider: 'oops' }));
      writeConfig(project, 'opencode.json', json({
        provider: {
          a: { models: { y: { modelID: 'project-y' } } },
          b: { models: { 'b/model': {} } },
          both: { models: { x: { modelID: 'project-x' } } },
        },
      }));

      const result = withEnv({ XDG_CONFIG_HOME: home }, () =>
        readHermeticHostConfig({ cwd: project, includeProject: true }));

      expect(result.provider).toEqual({
        a: { models: { x: { modelID: 'global-x' }, y: { modelID: 'project-y' } } },
        b: { models: { 'b/model': {} } },
        both: { models: { x: { modelID: 'project-x' } } },
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
        expect(readHermeticHostConfig({ cwd: nested, includeProject: true }).model).toBe('nearest/model');
        rmSync(join(nested, 'opencode.json'));
        expect(readHermeticHostConfig({ cwd: nested, includeProject: true }).model).toBe('parent/model');
        expect(readHermeticHostConfig({ cwd: nested }).model).toBe('global/model');
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
        readHermeticHostConfig({ cwd: project, includeProject: true }).model)).toBe('nested/model');
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
        readHermeticHostConfig({ cwd: project, includeProject: true }));

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
        expect(readHermeticHostConfig(options)).toEqual({
          model: 'project/model',
          provider: { explicit: { models: { 'explicit/model': {} } } },
        });
        expect(readHermeticHostConfig({ ...options, explicitConfigMode: 'replace' })).toEqual({
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

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig()))
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

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig()))
        .toEqual({ model: 'main/v2', smallModel: 'small/v2' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads V2 providers from the providers field', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        model: 'host/hy4-flash-free',
        providers: {
          host: { models: { 'hy4-flash-free': { modelID: 'hy4-flash-free' } } },
        },
      }));

      const result = withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig());

      expect(result.provider).toEqual({
        host: { models: { 'hy4-flash-free': { modelID: 'hy4-flash-free' } } },
      });
      expect(resolveEndpointModelId('host/hy4-flash-free', result.provider))
        .toBe('hy4-flash-free');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prefers the V2 providers field over a V1 provider field', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({
        provider: { legacy: { models: { a: {} } } },
        providers: { v2: { models: { b: {} } } },
      }));

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig()).provider)
        .toEqual({ v2: { models: { b: {} } } });
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

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig())).toEqual({
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

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig())).toEqual({});
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

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig()))
        .toEqual({ model: 'jsonc/model' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('merges opencode.json and opencode.jsonc in the same directory, with jsonc winning', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    try {
      const directory = join(home, 'opencode');
      writeConfig(directory, 'opencode.json', json({ model: 'json/model' }));
      writeConfig(directory, 'opencode.jsonc', json({ model: 'jsonc/model', small_model: 'jsonc/small' }));

      expect(withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig()))
        .toEqual({ model: 'jsonc/model', smallModel: 'jsonc/small' });
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

      const result = withEnv({ XDG_CONFIG_HOME: home }, () => readHermeticHostConfig());

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
        expect(readHermeticHostConfig().model).toBe('env-dir/model');
        expect(readHermeticHostConfig({ configDir: explicitDir }).model).toBe('explicit-dir/model');
        withEnv({ ...vars, OPENCODE_CONFIG: explicitFile }, () => {
          expect(readHermeticHostConfig({ configDir: explicitDir }).model).toBe('explicit-file/model');
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-read-failures', () => {
  it('warns once per unreadable path, reports it, and warns again after a reset', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    const warnings: unknown[][] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    try {
      const unreadable = join(home, 'not-a-file');
      mkdirSync(unreadable);
      resetOpenCodeHostConfigReadFailuresForTesting();
      warnings.length = 0;

      withEnv({ OPENCODE_CONFIG: unreadable }, () => {
        readHermeticHostConfig();
        readHermeticHostConfig();
      });

      const sdkWarnings = warnings.filter(args => args[0] === 'SDK');
      expect(sdkWarnings).toHaveLength(1);
      expect(sdkWarnings[0][1]).toContain(unreadable);

      const failures = getOpenCodeHostConfigReadFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0].path).toBe(unreadable);
      expect(failures[0].reason.length).toBeGreaterThan(0);
      // The getter hands back a copy: mutating it must not change internal state.
      (failures as { path: string; reason: string }[]).length = 0;
      expect(getOpenCodeHostConfigReadFailures()).toHaveLength(1);

      resetOpenCodeHostConfigReadFailuresForTesting();
      expect(getOpenCodeHostConfigReadFailures()).toEqual([]);

      withEnv({ OPENCODE_CONFIG: unreadable }, () => readHermeticHostConfig());
      expect(warnings.filter(args => args[0] === 'SDK')).toHaveLength(2);
    } finally {
      resetOpenCodeHostConfigReadFailuresForTesting();
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never copies a parse error message that can quote file contents', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    const warnings: unknown[][] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    try {
      const sentinel = 'GREPTILE_PARSE_SECRET_DO_NOT_LEAK_9F3C';
      const bad = writeConfig(join(home, 'opencode'), 'opencode.json', `{"model":${sentinel}}`);
      resetOpenCodeHostConfigReadFailuresForTesting();
      warnings.length = 0;

      withEnv({ OPENCODE_CONFIG: bad }, () => readHermeticHostConfig());

      const failures = getOpenCodeHostConfigReadFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0].path).toBe(bad);
      expect(failures[0].reason).toBe('invalid JSON (parse details omitted to avoid leaking file contents)');
      const logged = warnings.filter(args => args[0] === 'SDK').map(args => args.join(' ')).join('\n');
      expect(logged).not.toContain(sentinel);
    } finally {
      resetOpenCodeHostConfigReadFailuresForTesting();
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports a config hidden behind an unreadable directory', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    const warnings: unknown[][] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    const dir = join(home, 'locked');
    try {
      const blocked = writeConfig(dir, 'opencode.json', json({ model: 'hidden/model' }));
      chmodSync(dir, 0);
      resetOpenCodeHostConfigReadFailuresForTesting();
      warnings.length = 0;

      const config = withEnv({ OPENCODE_CONFIG: blocked }, () => readHermeticHostConfig());

      expect(config.model).not.toBe('hidden/model');
      const failures = getOpenCodeHostConfigReadFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0].path).toBe(blocked);
      expect(failures[0].reason).toContain('permission denied');
      expect(warnings.filter(args => args[0] === 'SDK')).toHaveLength(1);
    } finally {
      chmodSync(dir, 0o700);
      resetOpenCodeHostConfigReadFailuresForTesting();
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports a config blocked by a non-directory path component', () => {
    if (process.platform === 'win32') return;
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    const warnings: unknown[][] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    try {
      const blocker = writeConfig(home, 'not-a-dir', 'x');
      const blocked = join(blocker, 'opencode.json');
      resetOpenCodeHostConfigReadFailuresForTesting();
      warnings.length = 0;

      withEnv({ OPENCODE_CONFIG: blocked }, () => readHermeticHostConfig());

      const failures = getOpenCodeHostConfigReadFailures();
      expect(failures).toHaveLength(1);
      expect(failures[0].path).toBe(blocked);
      expect(failures[0].reason).toContain('ENOTDIR');
      expect(warnings.filter(args => args[0] === 'SDK')).toHaveLength(1);
    } finally {
      resetOpenCodeHostConfigReadFailuresForTesting();
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('stays silent for a genuinely missing config path', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-'));
    const warnings: unknown[][] = [];
    const warn = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
    try {
      const missing = join(home, 'absent', 'opencode.json');
      resetOpenCodeHostConfigReadFailuresForTesting();
      warnings.length = 0;

      withEnv({ OPENCODE_CONFIG: missing }, () => readHermeticHostConfig());

      expect(getOpenCodeHostConfigReadFailures()).toEqual([]);
      expect(warnings.filter(args => args[0] === 'SDK')).toEqual([]);
    } finally {
      resetOpenCodeHostConfigReadFailuresForTesting();
      warn.mockRestore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-source-tracking', () => {
  it('reports the file that last set each field, and leaves the default shape untouched', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-sources-'));
    try {
      const globalDir = join(home, 'opencode');
      const globalFile = writeConfig(globalDir, 'opencode.json', json({
        model: 'global/model',
        small_model: 'global/small',
        provider: {
          global: { models: { 'global/model': {} } },
          shared: { models: { 'global/shared': {} } },
        },
      }));
      const project = join(home, 'project');
      const projectFile = writeConfig(project, 'opencode.json', json({
        model: 'project/model',
        // A provider map merged field by field still takes its source from the
        // last file that wrote that provider id.
        provider: { shared: { models: { 'project/shared': {} } } },
      }));

      withEnv({ XDG_CONFIG_HOME: home }, () => {
        const result = readOpenCodeHostConfig({
          cwd: project, includeProject: true, includeSources: true, systemConfigDirs: [],
        });
        expect(result.model).toBe('project/model');
        expect(result.sources?.model).toEqual({ kind: 'project', path: projectFile });
        expect(result.sources?.smallModel).toEqual({ kind: 'global', path: globalFile });
        expect(result.sources?.provider).toEqual({ kind: 'project', path: projectFile });
        expect(result.provider).toEqual({
          global: { models: { 'global/model': {} } },
          shared: { models: { 'global/shared': {}, 'project/shared': {} } },
        });

        const globalOnly = readOpenCodeHostConfig({ includeSources: true, systemConfigDirs: [] });
        expect(globalOnly.sources?.model).toEqual({ kind: 'global', path: globalFile });

        const explicitFile = writeConfig(join(home, 'explicit'), 'custom.json', json({
          model: 'explicit/model',
        }));
        withEnv({ OPENCODE_CONFIG: explicitFile }, () => {
          const explicit = readOpenCodeHostConfig({
            cwd: project, includeProject: true, includeSources: true, systemConfigDirs: [],
          });
          expect(explicit.model).toBe('explicit/model');
          expect(explicit.sources?.model).toEqual({ kind: 'explicit', path: explicitFile });
        });

        // Without the opt-in the rendered object keeps exactly the old shape.
        expect(readOpenCodeHostConfig({ cwd: project, includeProject: true, systemConfigDirs: [] })).toEqual({
          model: 'project/model',
          smallModel: 'global/small',
          provider: {
            global: { models: { 'global/model': {} } },
            shared: { models: { 'global/shared': {}, 'project/shared': {} } },
          },
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-system-precedence', () => {
  it('applies injected system dirs in reverse order, between global and project', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-system-'));
    try {
      const managedDir = join(home, 'managed');
      const systemDir = join(home, 'system');
      const managedFile = writeConfig(managedDir, 'opencode.json', json({ model: 'managed/model' }));
      const systemFile = writeConfig(systemDir, 'opencode.json', json({ model: 'system/model' }));
      writeConfig(join(home, 'opencode'), 'opencode.json', json({ model: 'global/model' }));
      const project = join(home, 'project');
      writeConfig(project, 'opencode.json', json({ model: 'project/model' }));
      const systemDirs = [managedDir, systemDir];

      withEnv({ XDG_CONFIG_HOME: home }, () => {
        const withProject = readOpenCodeHostConfig({
          cwd: project, includeProject: true, includeSources: true, systemConfigDirs: systemDirs,
        });
        expect(withProject.model).toBe('project/model');
        expect(withProject.sources?.model?.kind).toBe('project');

        const withoutProject = readOpenCodeHostConfig({ includeSources: true, systemConfigDirs: systemDirs });
        expect(withoutProject.model).toBe('managed/model');
        expect(withoutProject.sources?.model).toEqual({ kind: 'system', path: managedFile });

        const systemOnly = readOpenCodeHostConfig({ includeSources: true, systemConfigDirs: [systemDir] });
        expect(systemOnly.model).toBe('system/model');
        expect(systemOnly.sources?.model).toEqual({ kind: 'system', path: systemFile });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-system-skipped-with-config-dir', () => {
  it('never reads system dirs when an explicit config directory is supplied', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-host-config-system-skip-'));
    try {
      writeConfig(join(home, 'opencode'), 'opencode.json', json({ model: 'global/model' }));
      writeConfig(join(home, 'managed'), 'opencode.json', json({ model: 'managed/model' }));
      writeConfig(join(home, 'system'), 'opencode.json', json({ model: 'system/model' }));
      const configDir = join(home, 'chosen');
      writeConfig(configDir, 'opencode.json', json({ model: 'chosen/model' }));

      const result = withEnv({ XDG_CONFIG_HOME: home }, () => readOpenCodeHostConfig({
        configDir,
        includeSources: true,
        systemConfigDirs: [join(home, 'managed'), join(home, 'system')],
      }));

      expect(result.model).toBe('chosen/model');
      expect(result.sources?.model?.kind).toBe('global');
      expect(result.model).not.toBe('managed/model');
      expect(result.model).not.toBe('system/model');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('host-config-system-platform', () => {
  it('derives system paths from the given platform without mutating process.platform', () => {
    const platformBefore = process.platform;
    expect(systemConfigDirectories('linux')).toContain('/etc/opencode');
    expect(systemConfigDirectories('win32'))
      .toContain(join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'opencode'));
    expect(systemConfigDirectories('darwin'))
      .toContain('/Library/Application Support/opencode');
    expect(systemConfigDirectories('darwin'))
      .toContain('/Library/Managed Preferences/opencode');
    expect(process.platform).toBe(platformBefore);
  });
});
