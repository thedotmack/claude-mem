import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  findClaudeExecutable,
  resetClaudeExecutableCache,
  CAPABILITY_PROBE_ARGS,
  _internals,
} from '../../src/shared/find-claude-executable.js';
import { logger } from '../../src/utils/logger.js';

/**
 * All probing goes through the _internals seam, so these tests swap its
 * members instead of module-mocking child_process (mock.module is
 * process-global and sticky in bun — see tests/preload.ts notes).
 */

interface FakeCli {
  version: string;
  supportsDontAsk: boolean;
  /** Fails every probe (corrupt install / desktop app) — the `broken` branch. */
  broken?: boolean;
}

const ORIGINALS = { ..._internals };

/** Paths that exist in the fake filesystem and how each fake CLI behaves. */
let fakeClis: Map<string, FakeCli>;
/** Every execFileSync invocation, for probe-count assertions. */
let probeCalls: Array<{ path: string; args: string[] }>;
/** Symlink map for realpathSync; identity when absent. */
let realPaths: Map<string, string>;
/** stdout of `which -a claude`; null = which fails. */
let whichOutput: string | null;

function installFakes(options: { settingsPath?: string; platform?: NodeJS.Platform; whereOutputs?: Record<string, string> } = {}): void {
  _internals.platform = () => options.platform ?? 'darwin';
  _internals.homedir = () => '/home/tester';
  _internals.loadSettings = () => ({ CLAUDE_CODE_PATH: options.settingsPath ?? '' }) as ReturnType<typeof ORIGINALS.loadSettings>;
  _internals.existsSync = (path) => fakeClis.has(String(path));
  _internals.realpathSync = ((path: string) => realPaths.get(path) ?? path) as typeof ORIGINALS.realpathSync;

  _internals.execSync = ((command: string) => {
    if (options.whereOutputs && command in options.whereOutputs) {
      return options.whereOutputs[command];
    }
    if (command === 'which -a claude' && whichOutput !== null) {
      return whichOutput;
    }
    throw new Error(`not found: ${command}`);
  }) as typeof ORIGINALS.execSync;

  _internals.execFileSync = ((path: string, args: string[]) => {
    probeCalls.push({ path, args });
    const real = realPaths.get(path) ?? path;
    const cli = fakeClis.get(path) ?? fakeClis.get(real);
    if (!cli) {
      const error = new Error(`spawn ${path} ENOENT`) as Error & { stderr: string };
      error.stderr = '';
      throw error;
    }
    if (cli.broken) {
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = 'cannot execute binary file';
      throw error;
    }
    if (args.includes('--permission-mode') && !cli.supportsDontAsk) {
      const error = new Error('Command failed') as Error & { stderr: string };
      error.stderr = "error: option '--permission-mode <mode>' argument 'dontAsk' is invalid. Allowed choices are acceptEdits, bypassPermissions, default, plan.";
      throw error;
    }
    return `${cli.version} (Claude Code)`;
  }) as typeof ORIGINALS.execFileSync;
}

beforeEach(() => {
  resetClaudeExecutableCache();
  fakeClis = new Map();
  probeCalls = [];
  realPaths = new Map();
  whichOutput = null;
});

afterEach(() => {
  Object.assign(_internals, ORIGINALS);
  resetClaudeExecutableCache();
});

describe('findClaudeExecutable candidate selection', () => {
  it('prefers the newest capable CLI over a stale binary earlier in PATH', () => {
    // The exact incident shape: abandoned npm-global 2.0.42 shadows the
    // auto-updated 2.1.176 in PATH order.
    installFakes();
    whichOutput = '/opt/homebrew/bin/claude\n/home/tester/.local/bin/claude\n';
    fakeClis.set('/opt/homebrew/bin/claude', { version: '2.0.42', supportsDontAsk: false });
    fakeClis.set('/home/tester/.local/bin/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/home/tester/.local/bin/claude');
  });

  it('prefers the higher version when several candidates are capable', () => {
    installFakes();
    whichOutput = '/a/claude\n/b/claude\n';
    fakeClis.set('/a/claude', { version: '2.1.100', supportsDontAsk: true });
    fakeClis.set('/b/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/b/claude');
  });

  it('breaks version ties by PATH order', () => {
    installFakes();
    whichOutput = '/a/claude\n/b/claude\n';
    fakeClis.set('/a/claude', { version: '2.1.176', supportsDontAsk: true });
    fakeClis.set('/b/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/a/claude');
  });

  it('throws an actionable error naming every too-old candidate when none are capable', () => {
    installFakes();
    whichOutput = '/opt/homebrew/bin/claude\n';
    fakeClis.set('/opt/homebrew/bin/claude', { version: '2.0.42', supportsDontAsk: false });

    expect(() => findClaudeExecutable('SDK')).toThrow(/too old/);
    try {
      findClaudeExecutable('SDK');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('/opt/homebrew/bin/claude');
      expect(message).toContain('2.0.42');
      expect(message).toContain('dontAsk');
      expect(message).toContain('CLAUDE_CODE_PATH');
    }
  });

  it('falls back to known install locations when PATH has no claude', () => {
    installFakes();
    whichOutput = null;
    fakeClis.set('/home/tester/.local/bin/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/home/tester/.local/bin/claude');
  });

  it('dedupes PATH repeats and symlink aliases to a single probe', () => {
    installFakes();
    whichOutput = '/a/claude\n/a/claude\n/alias/claude\n';
    realPaths.set('/alias/claude', '/a/claude');
    fakeClis.set('/a/claude', { version: '2.1.176', supportsDontAsk: true });
    fakeClis.set('/alias/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/a/claude');
    expect(probeCalls.filter((call) => call.args.includes('--permission-mode')).length).toBe(1);
  });

  it('keeps the not-found error when nothing is installed', () => {
    installFakes();
    expect(() => findClaudeExecutable('SDK')).toThrow(/Claude executable not found/);
  });
});

describe('findClaudeExecutable broken candidates', () => {
  // A "broken" install fails BOTH the capability probe and plain --version
  // (corrupt binary, dangling symlink, desktop app). Distinct from
  // "incompatible", which still answers --version.
  const ORIGINAL_WARN = logger.warn;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    logger.warn = ((_component: unknown, message: string) => {
      warnings.push(message);
    }) as typeof logger.warn;
  });

  afterEach(() => {
    logger.warn = ORIGINAL_WARN;
  });

  it('skips a broken candidate with a --version-check warning and picks the capable CLI', () => {
    installFakes();
    whichOutput = '/broken/claude\n/good/claude\n';
    fakeClis.set('/broken/claude', { version: '0.0.0', supportsDontAsk: false, broken: true });
    fakeClis.set('/good/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/good/claude');
    expect(warnings.some((m) => m.includes('/broken/claude') && m.includes('failed --version check'))).toBe(true);
  });

  it('warns with desktop-app guidance when the broken candidate is a desktop-app path', () => {
    installFakes({
      platform: 'win32',
      whereOutputs: {
        'where claude': 'C:\\Users\\tester\\AppData\\Local\\AnthropicClaude\\claude.exe\r\nC:\\good\\claude.exe\r\n',
      },
    });
    fakeClis.set('C:\\Users\\tester\\AppData\\Local\\AnthropicClaude\\claude.exe', { version: '0.0.0', supportsDontAsk: false, broken: true });
    fakeClis.set('C:\\good\\claude.exe', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('C:\\good\\claude.exe');
    expect(warnings.some((m) => m.includes('desktop app') && m.includes('AnthropicClaude'))).toBe(true);
  });

  it('falls through to not-found when the only candidate is broken', () => {
    installFakes();
    whichOutput = '/broken/claude\n';
    fakeClis.set('/broken/claude', { version: '0.0.0', supportsDontAsk: false, broken: true });

    expect(() => findClaudeExecutable('SDK')).toThrow(/Claude executable not found/);
  });

  it('reports a broken configured CLAUDE_CODE_PATH with the probe failure', () => {
    installFakes({ settingsPath: '/custom/claude' });
    fakeClis.set('/custom/claude', { version: '0.0.0', supportsDontAsk: false, broken: true });

    expect(() => findClaudeExecutable('SDK')).toThrow(/failed the --version check/);
  });

  it('reports a desktop-app CLAUDE_CODE_PATH with CLI install guidance', () => {
    const desktopPath = 'C:\\Users\\tester\\AppData\\Local\\AnthropicClaude\\claude.exe';
    installFakes({ settingsPath: desktopPath });
    fakeClis.set(desktopPath, { version: '0.0.0', supportsDontAsk: false, broken: true });

    expect(() => findClaudeExecutable('SDK')).toThrow(/desktop app/);
  });
});

describe('findClaudeExecutable explicit CLAUDE_CODE_PATH', () => {
  it('returns a capable configured path without scanning PATH', () => {
    installFakes({ settingsPath: '/custom/claude' });
    fakeClis.set('/custom/claude', { version: '2.1.150', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/custom/claude');
    // Discovery (`which`) must not run when the override resolves.
    expect(probeCalls.every((call) => call.path === '/custom/claude')).toBe(true);
  });

  it('fails loud when the configured path is too old instead of dying at spawn', () => {
    installFakes({ settingsPath: '/custom/claude' });
    fakeClis.set('/custom/claude', { version: '2.0.42', supportsDontAsk: false });

    expect(() => findClaudeExecutable('SDK')).toThrow(/too old/);
    expect(() => findClaudeExecutable('SDK')).toThrow(/2\.0\.42/);
  });

  it('still reports a missing configured path', () => {
    installFakes({ settingsPath: '/missing/claude' });
    expect(() => findClaudeExecutable('SDK')).toThrow(/does not exist/);
  });
});

describe('findClaudeExecutable caching', () => {
  it('caches a successful resolution and skips re-probing', () => {
    installFakes();
    whichOutput = '/a/claude\n';
    fakeClis.set('/a/claude', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/a/claude');
    const probesAfterFirst = probeCalls.length;
    expect(findClaudeExecutable('SDK')).toBe('/a/claude');
    expect(probeCalls.length).toBe(probesAfterFirst);

    resetClaudeExecutableCache();
    findClaudeExecutable('SDK');
    expect(probeCalls.length).toBeGreaterThan(probesAfterFirst);
  });

  it('never caches failure — a fixed CLI is picked up on the next call', () => {
    installFakes();
    whichOutput = '/a/claude\n';
    fakeClis.set('/a/claude', { version: '2.0.42', supportsDontAsk: false });
    expect(() => findClaudeExecutable('SDK')).toThrow(/too old/);

    // User updates the CLI in place; no cache reset, no worker restart.
    fakeClis.set('/a/claude', { version: '2.1.176', supportsDontAsk: true });
    expect(findClaudeExecutable('SDK')).toBe('/a/claude');
  });

  it('re-resolves when the cached binary disappears', () => {
    installFakes();
    whichOutput = '/a/claude\n/b/claude\n';
    fakeClis.set('/a/claude', { version: '2.1.176', supportsDontAsk: true });
    fakeClis.set('/b/claude', { version: '2.1.100', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('/a/claude');
    fakeClis.delete('/a/claude');
    whichOutput = '/b/claude\n';
    expect(findClaudeExecutable('SDK')).toBe('/b/claude');
  });
});

describe('findClaudeExecutable on Windows', () => {
  it('probes where-discovered candidates and applies the same version preference', () => {
    installFakes({
      platform: 'win32',
      whereOutputs: {
        'where claude.cmd': 'C:\\old\\claude.cmd\r\n',
        'where claude': 'C:\\new\\claude.exe\r\n',
      },
    });
    fakeClis.set('C:\\old\\claude.cmd', { version: '2.0.42', supportsDontAsk: false });
    fakeClis.set('C:\\new\\claude.exe', { version: '2.1.176', supportsDontAsk: true });

    expect(findClaudeExecutable('SDK')).toBe('C:\\new\\claude.exe');
  });
});

describe('capability probe contract', () => {
  it('passes the exact flags hardened options force on every spawn', () => {
    // buildHardenedSdkOptions sets permissionMode 'dontAsk' unconditionally;
    // the probe must cover it or stale CLIs die at spawn instead of resolve.
    expect([...CAPABILITY_PROBE_ARGS]).toEqual(['--permission-mode', 'dontAsk', '--version']);
  });
});
