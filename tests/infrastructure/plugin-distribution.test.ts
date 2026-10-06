import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCodexWindowsCommand, buildShellCommand } from '../../src/build/hook-shell-template.js';
import { HOOK_TIMEOUTS } from '../../src/shared/hook-constants.js';
import { FILE_CONTEXT_WORKER_BUDGET_MS } from '../../src/cli/handlers/file-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf-8'));
}

function commandHooksFrom(relativePath: string): string[] {
  const parsed = readJson(relativePath);
  return Object.values(parsed.hooks ?? {}).flatMap((matchers: any) =>
    matchers.flatMap((matcher: any) =>
      (matcher.hooks ?? [])
        .filter((hook: any) => hook.type === 'command')
        .map((hook: any) => String(hook.command ?? ''))
    )
  );
}

function commandHookEntriesFrom(relativePath: string): any[] {
  const parsed = readJson(relativePath);
  return Object.values(parsed.hooks ?? {}).flatMap((matchers: any) =>
    matchers.flatMap((matcher: any) =>
      (matcher.hooks ?? []).filter((hook: any) => hook.type === 'command')
    )
  );
}

function mcpStartupCommandFrom(relativePath: string): string {
  const parsed = readJson(relativePath);
  return parsed.mcpServers['mcp-search'].args[1];
}

/** PATH export through the first `; _C=` marker in Claude hook commands. */
function claudePathPreludeFrom(command: string): string {
  const marker = '; _C=';
  const end = command.indexOf(marker);
  expect(end).toBeGreaterThan(0);
  return command.slice(0, end + 1);
}

function posixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Map Windows %TEMP% paths to Git bash /tmp/... so shell-eval assertions match locally and on CI. */
function normalizeShellPath(p: string): string {
  const posix = posixPath(p).replace(/\/+$/, '');
  const tempMapped = posix.match(
    /^(?:[A-Za-z]:)?\/(?:Users\/[^/]+\/)?AppData\/Local\/Temp\/(.+)$/i,
  );
  if (tempMapped) {
    return `/tmp/${tempMapped[1]}`;
  }
  return posix;
}

function expectResolvedPath(stdout: string, expectedRoot: string): void {
  const match = stdout.match(/RESOLVED=(.+)/);
  expect(match).not.toBeNull();
  expect(normalizeShellPath(match![1].trim())).toBe(normalizeShellPath(expectedRoot));
}

function bashExecutable(): string {
  if (process.platform === 'win32') {
    const gitBash = 'C:/Program Files/Git/bin/bash.exe';
    if (existsSync(gitBash)) {
      return gitBash;
    }
  }
  return 'bash';
}

function installFakeNvmNode(home: string, version: string): string {
  const nodeBin = path.join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin');
  mkdirSync(nodeBin, { recursive: true });
  const nodePath = path.join(nodeBin, 'node');
  writeFileSync(nodePath, '#!/bin/sh\necho "fake-node"\n');
  chmodSync(nodePath, 0o755);
  return nodeBin;
}

function shellEval(command: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(bashExecutable(), ['-c', command], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf-8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('Plugin Distribution - Skills', () => {
  const skillPath = path.join(projectRoot, 'plugin/skills/mem-search/SKILL.md');
  const modeCreatorPath = path.join(projectRoot, 'plugin/skills/mode-creator/SKILL.md');

  it('should include plugin/skills/mem-search/SKILL.md', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('should have valid YAML frontmatter with name and description', () => {
    const content = readFileSync(skillPath, 'utf-8');

    expect(content.startsWith('---\n')).toBe(true);

    const frontmatterEnd = content.indexOf('\n---\n', 4);
    expect(frontmatterEnd).toBeGreaterThan(0);

    const frontmatter = content.slice(4, frontmatterEnd);
    expect(frontmatter).toContain('name:');
    expect(frontmatter).toContain('description:');
  });

  it('should reference the 3-layer search workflow', () => {
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('search');
    expect(content).toContain('timeline');
    expect(content).toContain('get_observations');
  });

  it('should include the mode creator workflow and installers', () => {
    expect(existsSync(modeCreatorPath)).toBe(true);
    expect(existsSync(path.join(projectRoot, 'plugin/skills/mode-creator/scripts/install-mode.mjs'))).toBe(true);
    expect(existsSync(path.join(projectRoot, 'plugin/skills/mode-creator/scripts/configure-telegram.mjs'))).toBe(true);
  });
});

describe('Plugin Distribution - Required Files', () => {
  const requiredFiles = [
    'plugin/hooks/hooks.json',
    'plugin/hooks/codex-hooks.json',
    'plugin/.claude-plugin/plugin.json',
    'plugin/.codex-plugin/plugin.json',
    'plugin/.mcp.json',
    'plugin/sqlite/SessionStore.js',
    'plugin/sqlite/observations/files.js',
    'plugin/skills/mem-search/SKILL.md',
    'plugin/skills/mode-creator/SKILL.md',
    '.agents/plugins/marketplace.json',
    '.cursor-plugin/marketplace.json',
    'claude-mem-cursor/.cursor-plugin/plugin.json',
    'claude-mem-cursor/mcp.json',
    'claude-mem-cursor/hooks/hooks.json',
    'claude-mem-grok-bot/.cursor-plugin/plugin.json',
    'claude-mem-grok-bot/mcp.json',
    'claude-mem-grok-bot/skills/host-observer/SKILL.md',
  ];

  for (const filePath of requiredFiles) {
    it(`should include ${filePath}`, () => {
      const fullPath = path.join(projectRoot, filePath);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Plugin Distribution - Codex Marketplace', () => {
  it('points Codex at the bundled plugin root', () => {
    const marketplacePath = path.join(projectRoot, '.agents/plugins/marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'));

    expect(marketplace.plugins[0].source.path).toBe('./plugin');
  });

  it('ships Codex hooks with only Codex-supported root keys', () => {
    const codexHooks = readJson('plugin/hooks/codex-hooks.json');
    expect(Object.keys(codexHooks).sort()).toEqual(['hooks']);
  });

  it('re-injects Codex memory on every SessionStart source that starts a fresh context', () => {
    // Codex emits startup, resume, clear and compact (SessionStartSource in
    // codex-rs/hooks/src/events/session_start.rs). clear and compact both hand
    // the model an empty context, so the injection hook has to run for them or
    // the session continues with no memory.
    const codexHooks = readJson('plugin/hooks/codex-hooks.json');
    const matchers = codexHooks.hooks.SessionStart.map((entry: any) => entry.matcher);

    expect(matchers).toHaveLength(1);
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      expect(matchers[0].split('|')).toContain(source);
    }
  });

  it('sets the Codex hook marker on every Codex command', () => {
    for (const command of commandHooksFrom('plugin/hooks/codex-hooks.json')) {
      expect(command).toContain('CLAUDE_MEM_CODEX_HOOK=1');
    }
  });

  it('sets Windows Codex hook overrides without POSIX-only shell syntax', () => {
    const entries = commandHookEntriesFrom('plugin/hooks/codex-hooks.json');
    const posixOnlyTokens = ['$(', '${', '[ -', 'printenv', 'export PATH', 'command -v', '2>/dev/null', 'while IFS'];

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.commandWindows).toBe('string');
      expect(entry.commandWindows).toContain('node -e');
      expect(entry.commandWindows).toContain('CLAUDE_MEM_CODEX_HOOK');
      expect(entry.commandWindows).toContain('bun-runner.js');
      expect(entry.commandWindows).toContain('worker-service.cjs');
      expect(entry.commandWindows).toContain('plugins');
      expect(entry.commandWindows).toContain('cache');
      expect(entry.commandWindows).toContain('marketplaces');
      for (const token of posixOnlyTokens) {
        expect(entry.commandWindows).not.toContain(token);
      }
    }
  });

  it('ships a single Codex SessionStart command', () => {
    const codexHooks = readJson('plugin/hooks/codex-hooks.json');
    expect(codexHooks.hooks.SessionStart[0].hooks).toHaveLength(1);
    expect(codexHooks.hooks.SessionStart[0].hooks[0].command).not.toContain('version-check.js');
    expect(codexHooks.hooks.SessionStart[0].hooks[0].commandWindows).not.toContain('version-check.js');
  });

  it('MCP launcher can recover without plugin root environment variables', () => {
    const mcpPath = path.join(projectRoot, 'plugin/.mcp.json');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    const command = mcp.mcpServers['mcp-search'].args.join(' ');

    expect(command).toContain('.codex/plugins/cache/claude-mem-local/claude-mem');
    expect(command).toContain('plugins/cache/thedotmack/claude-mem');
    expect(command).toContain('claude-mem: mcp server not found');
  });
});


describe('Plugin Distribution - Cursor Marketplace', () => {
  it('ships independent Cursor and Grok Bot marketplace entries', () => {
    const marketplace = readJson('.cursor-plugin/marketplace.json');
    expect(marketplace.owner.name).toBe('Alex Newman');
    expect(marketplace.plugins.map((plugin: any) => plugin.name)).toEqual([
      'claude-mem-cursor',
      'claude-mem-grok-bot',
    ]);
  });

  it('wires Cursor hooks through the npx hook entrypoint', () => {
    const hooks = readJson('claude-mem-cursor/hooks/hooks.json');
    expect(hooks.hooks.beforeSubmitPrompt[0].command).toContain('npx -y claude-mem hook cursor session-init');
    expect(hooks.hooks.stop[0].command).toContain('npx -y claude-mem hook cursor summarize');
  });

  it('ships the shared local and remote MCP definitions for both plugins', () => {
    for (const relativePath of ['claude-mem-cursor/mcp.json', 'claude-mem-grok-bot/mcp.json']) {
      const mcp = readJson(relativePath);
      expect(mcp.mcpServers['claude-mem-local'].args).toEqual(['-y', 'claude-mem', 'mcp']);
      const expected = 'Bearer ' + '${' + 'CLAUDE_MEM_MCP_TOKEN' + '}';
      expect(mcp.mcpServers['claude-mem-remote'].headers.Authorization).toBe(expected);
    }
  });
});

describe('Plugin Distribution - hooks.json Integrity', () => {
  it('should have valid JSON in hooks.json', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeDefined();
  });

  it('should reference CLAUDE_PLUGIN_ROOT in all hook commands', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain('CLAUDE_PLUGIN_ROOT');
    }
  });

  it('should include CLAUDE_PLUGIN_ROOT fallback in all hook commands (#1215)', () => {
    const expectedFallbackPath = '$_C/plugins/marketplaces/thedotmack/plugin';

    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain(expectedFallbackPath);
    }
  });

  it('should try cache path before marketplaces fallback in all hook commands (#1533)', () => {
    const cachePath = '$_C/plugins/cache/thedotmack/claude-mem';
    const marketplacesPath = '$_C/plugins/marketplaces/thedotmack/plugin';

    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain(cachePath);
      expect(command.indexOf(cachePath)).toBeLessThan(command.indexOf(marketplacesPath));
    }
  });

  it('should not spawn a login shell to rebuild PATH on every Claude hook (#3190)', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).not.toContain('SHELL -lc');
    }
  });

  it('should quote NVM ls path inside export PATH (#3190)', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toMatch(/ls "\$HOME\/\.nvm\/versions\/node"/);
      expect(command).not.toMatch(/ls \\"\$HOME\/\.nvm\/versions\/node\\"/);
    }
  });
});

describe('Plugin Distribution - Startup Root Resolution', () => {
  it('MCP startup command resolves the plugin root cross-platform (#2792)', () => {
    // The launcher is now a cross-platform `node -e` payload (no `sh`), so it
    // runs on Windows without Git Bash. It must still resolve the plugin root
    // with config-dir + env fallbacks and try cache roots before marketplaces.
    const command = mcpStartupCommandFrom('plugin/.mcp.json');

    expect(command).toContain('CLAUDE_CONFIG_DIR');
    expect(command).toContain('.claude');
    expect(command).toContain('CLAUDE_PLUGIN_ROOT');
    expect(command).toContain('PLUGIN_ROOT');
    expect(command).toContain('plugins/marketplaces/thedotmack/plugin');
    expect(command).toContain('plugins/cache/thedotmack/claude-mem');
    expect(command).toContain('mcp-server.cjs');
    expect(command).toMatch(/require\(p\.resolve\(R,'scripts',["']mcp-server\.cjs["']\)\)/);
    expect(command).not.toContain('child_process');
    expect(command).not.toContain('.spawn(');
    // No bare absolute "/scripts/..." path leaks through.
    expect(command).not.toContain('"/scripts/mcp-server.cjs"');
    expect(command.indexOf('plugins/cache/thedotmack/claude-mem')).toBeLessThan(
      command.indexOf('plugins/marketplaces/thedotmack/plugin')
    );
  });

  it('Codex hook commands should have config-dir based non-empty fallbacks', () => {
    for (const command of commandHooksFrom('plugin/hooks/codex-hooks.json')) {
      expect(command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
      expect(command).toContain('export PATH=');
      expect(command).toContain('while IFS= read -r _R');
      expect(command).toContain('$_C/plugins/marketplaces/thedotmack/plugin');
      expect(command).toContain('$_C/plugins/cache/thedotmack/claude-mem');
      expect(command).toContain('[ -f "$_Q/scripts/');
      expect(command).toContain('command -v cygpath');
      expect(command.indexOf('$_C/plugins/cache/thedotmack/claude-mem')).toBeLessThan(
        command.indexOf('$_C/plugins/marketplaces/thedotmack/plugin')
      );
    }
  });

  it('Claude hook commands should have config-dir based non-empty fallbacks', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
      expect(command).toContain('while IFS= read -r _R');
      expect(command).toContain('$_C/plugins/marketplaces/thedotmack/plugin');
      expect(command).toContain('$_C/plugins/cache/thedotmack/claude-mem');
      expect(command).toContain('[ -f "$_Q/scripts/');
      expect(command).not.toContain('$HOME/.claude/plugins/');
    }
  });

  it('Claude runtime hooks fail open when plugin scripts cannot be resolved (#3412)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    try {
      const parsed = readJson('plugin/hooks/hooks.json');
      for (const [eventName, matchers] of Object.entries(parsed.hooks ?? {})) {
        if (eventName === 'Setup') continue;
        for (const matcher of matchers as any[]) {
          for (const hook of matcher.hooks ?? []) {
            if (hook.type !== 'command') continue;
            const result = shellEval(hook.command, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
            expect(result.status).toBe(0);
            expect(result.stderr).toContain('claude-mem: plugin scripts not found');
          }
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Plugin Distribution - MCP launcher process (#4269)', () => {
  // Runs the shipped plugin/.mcp.json entry against a fixture server that
  // prints its own pid. Loaded in-process, the server's pid is the launcher's,
  // so each MCP session costs one Node process rather than an idle launcher
  // plus a child.
  const { command, args } = readJson('plugin/.mcp.json').mcpServers['mcp-search'];

  function launchMcpServer(pluginRootFor: ((sandbox: string) => string) | null) {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'claude-mem-mcp-launch-'));
    try {
      mkdirSync(path.join(sandbox, 'fixture', 'scripts'), { recursive: true });
      writeFileSync(path.join(sandbox, 'fixture', 'scripts', 'mcp-server.cjs'), 'process.stdout.write(String(process.pid));\n');
      // An empty HOME and config dir, so no real install can satisfy a candidate.
      const home = path.join(sandbox, 'home');
      const configDir = path.join(sandbox, 'claude-config');
      mkdirSync(home);
      mkdirSync(configDir);
      const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir };
      delete env.CLAUDE_PLUGIN_ROOT;
      delete env.PLUGIN_ROOT;
      if (pluginRootFor) env.CLAUDE_PLUGIN_ROOT = pluginRootFor(sandbox);
      return spawnSync(command, args, { cwd: sandbox, env, encoding: 'utf-8', timeout: 20000 });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  it('runs the server inside the launcher process for an absolute plugin root', () => {
    const result = launchMcpServer(sandbox => path.join(sandbox, 'fixture'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(String(result.pid));
  });

  it('resolves a relative plugin root against the working directory', () => {
    const result = launchMcpServer(() => './fixture');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(String(result.pid));
  });

  it('exits 1 with the not-found message when no candidate has the server', () => {
    const result = launchMcpServer(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('claude-mem: mcp server not found');
  });
});

describe('Plugin Distribution - package.json Files Field', () => {
  it('runs bug-report from the bundled distribution entry', () => {
    const packageJson = readJson('package.json');

    expect(packageJson.scripts['bug-report']).toBe('node dist/bug-report/index.js');
    expect(packageJson.files).toContain('dist');
  });

  it('should include bundled plugin entries in root package.json files field', () => {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.files).toBeDefined();
    expect(packageJson.files).toContain('plugin/.codex-plugin');
    expect(packageJson.files).toContain('plugin/.mcp.json');
    expect(packageJson.files).toContain('plugin/hooks');
    expect(packageJson.files).toContain('plugin/skills');
    expect(packageJson.files).toContain('plugin/scripts/*.cjs');
    expect(packageJson.files).toContain('plugin/sqlite');
  });

  it('npm tarball includes generated runtime entries and the Claude marketplace root manifests (#3424)', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const packed = JSON.parse(result.stdout);
    const filePaths = new Set(packed[0].files.map((file: { path: string }) => file.path));

    expect(filePaths.has('dist/bug-report/index.js')).toBe(true);
    expect(filePaths.has('plugin/sqlite/SessionStore.js')).toBe(true);
    expect(filePaths.has('plugin/sqlite/observations/files.js')).toBe(true);
    expect(filePaths.has('.claude-plugin/marketplace.json')).toBe(true);
    expect(filePaths.has('.claude-plugin/plugin.json')).toBe(true);
  });
});

describe('Plugin Distribution - Build Script Verification', () => {
  it('should verify distribution files in build-hooks.js', () => {
    const buildScriptPath = path.join(projectRoot, 'scripts/build-hooks.js');
    const content = readFileSync(buildScriptPath, 'utf-8');

    expect(content).toContain('plugin/skills/mem-search/SKILL.md');
    expect(content).toContain('plugin/hooks/hooks.json');
    expect(content).toContain('plugin/sqlite/SessionStore.js');
    expect(content).toContain('plugin/sqlite/observations/files.js');
    expect(content).toContain('plugin/.claude-plugin/plugin.json');
    expect(content).toContain('dist/bug-report/index.js');
  });
});

describe('Plugin Distribution - Setup Hook (#1547)', () => {
  it('should not reference removed setup.sh in Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content).not.toContain('setup.sh');
  });

  it('should call version-check.js in the Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const setupHooks: any[] = parsed.hooks['Setup'] ?? [];

    const commandHooks = setupHooks.flatMap((matcher: any) =>
      (matcher.hooks ?? []).filter((h: any) => h.type === 'command')
    );

    expect(commandHooks.length).toBeGreaterThan(0);

    const versionCheckHooks = commandHooks.filter((h: any) =>
      h.command?.includes('version-check.js')
    );
    expect(versionCheckHooks.length).toBeGreaterThan(0);
  });

  it('version-check.js referenced by Setup hook should exist on disk', () => {
    const versionCheckPath = path.join(projectRoot, 'plugin/scripts/version-check.js');
    expect(existsSync(versionCheckPath)).toBe(true);
  });
});

describe('Plugin Distribution - Non-blocking bookkeeping hooks (#3206)', () => {
  it('runs observation, summarization, and SessionEnd asynchronously', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const postToolUse = parsed.hooks.PostToolUse[0].hooks[0];
    const postToolUseFailure = parsed.hooks.PostToolUseFailure[0].hooks[0];
    const stop = parsed.hooks.Stop[0].hooks[0];
    const sessionEnd = parsed.hooks.SessionEnd[0].hooks[0];

    expect(postToolUse.command).toContain('observation');
    expect(postToolUse.async).toBe(true);
    expect(parsed.hooks.PostToolUseFailure[0].matcher).toBe('*');
    expect(postToolUseFailure.command).toContain('observation');
    expect(postToolUseFailure.async).toBe(true);
    expect(stop.command).toContain('summarize');
    expect(stop.async).toBe(true);
    expect(sessionEnd.command).toContain('session-end');
    expect(sessionEnd.async).toBe(true);
  });

  it('runs the SessionStart worker start asynchronously and keeps context and UserPromptSubmit synchronous (#3303)', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const sessionStart = parsed.hooks.SessionStart.flatMap((group: any) => group.hooks);
    const workerStart = sessionStart.find((hook: any) => hook.command.includes('"$_P/scripts/worker-service.cjs" start'));
    const context = sessionStart.find((hook: any) => hook.command.includes(' hook claude-code context'));
    const userPromptSubmit = parsed.hooks.UserPromptSubmit[0].hooks[0];

    expect(sessionStart).toHaveLength(2);
    // `start` only prints a status envelope, and the context hook lazily
    // spawns the worker itself, so session start need not wait for it.
    expect(workerStart.command).toContain(' start');
    expect(workerStart.async).toBe(true);
    // `context` must stay synchronous: Claude Code hands an async hook's
    // additionalContext / systemMessage to the model on the next turn and never
    // shows the systemMessage to the user, which would hide the startup
    // timeline, the viewer link and the trial notice.
    expect(context.command).toContain(' hook claude-code context');
    expect(context).not.toHaveProperty('async');
    expect(userPromptSubmit.command).toContain(' hook claude-code session-init');
    // Keep prompt-row persistence ordered before downstream hooks consume it.
    expect(userPromptSubmit).not.toHaveProperty('async');
  });

  it('keeps the PreToolUse Read file-context hook synchronous so the File Read Gate can deny', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const preToolUseGroup = parsed.hooks.PreToolUse[0];
    const fileContext = preToolUseGroup.hooks[0];

    expect(preToolUseGroup.matcher).toBe('Read');
    expect(fileContext.command).toContain(' hook claude-code file-context');
    // Claude Code ignores permissionDecision from an async hook, so an async
    // file-context hook could never block a whole-file Read.
    expect(fileContext).not.toHaveProperty('async');
  });
});

// ---------------------------------------------------------------------------
// Spawn-contract templating (plans/02-spawn-contract-templating.md)
// ---------------------------------------------------------------------------

const ccTrailing = (...tail: string[]) => [
  'node', '"$_P/scripts/bun-runner.js"', '"$_P/scripts/worker-service.cjs"', ...tail,
];
const claudeHook = (tail: string[], extra: Record<string, unknown> = {}) => buildShellCommand({
  host: 'claude-code', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
  trailingCommand: ccTrailing(...tail), notFoundMessage: 'claude-mem: plugin scripts not found', failOpen: true, ...extra,
});
const codexHook = (tail: string[]) => buildShellCommand({
  host: 'codex-cli', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
  trailingCommand: ccTrailing(...tail), notFoundMessage: 'claude-mem: plugin scripts not found',
  extraEnv: { CLAUDE_MEM_CODEX_HOOK: '1' },
});
const codexHookPair = (tail: string[]) => ({
  command: codexHook(tail),
  commandWindows: buildCodexWindowsCommand(tail),
});

const SESSION_INIT_HOOK_TIMEOUT_SECONDS = 15;
const SESSION_INIT_HOOK_PATH = 'UserPromptSubmit.0.0';
const FILE_CONTEXT_HOOK_TIMEOUT_SECONDS = 15;
const FILE_CONTEXT_HOOK_PATH = 'PreToolUse.0.0';

type RuleAExpectation = string | { command: string; commandWindows?: string; timeout?: number };

const RULE_A_EXPECTATIONS: Record<string, Record<string, RuleAExpectation>> = {
  'plugin/hooks/hooks.json': {
    'Setup.0.0': buildShellCommand({
      host: 'claude-code-setup', requireFile: 'version-check.js',
      trailingCommand: ['node', '"$_P/scripts/version-check.js"'],
      notFoundMessage: 'claude-mem: version-check.js not found',
    }),
    // `start` already prints its own single, valid status JSON
    // (buildStatusOutput → {"continue":true,"status":"ready","suppressOutput":true}),
    // so NO trailingJson echo is appended — a second echoed object would
    // concatenate two JSON documents on stdout, which Claude Code cannot parse,
    // causing it to ignore suppressOutput and render the raw JSON at the top of
    // every session.
    'SessionStart.0.0': claudeHook(['start']),
    'SessionStart.1.0': claudeHook(['hook', 'claude-code', 'context']),
    'UserPromptSubmit.0.0': {
      command: claudeHook(['hook', 'claude-code', 'session-init']),
      timeout: SESSION_INIT_HOOK_TIMEOUT_SECONDS,
    },
    'PostToolUse.0.0': claudeHook(['hook', 'claude-code', 'observation']),
    'PostToolUseFailure.0.0': claudeHook(['hook', 'claude-code', 'observation']),
    'PreToolUse.0.0': {
      command: claudeHook(['hook', 'claude-code', 'file-context']),
      timeout: FILE_CONTEXT_HOOK_TIMEOUT_SECONDS,
    },
    'Stop.0.0': claudeHook(['hook', 'claude-code', 'summarize']),
    'SessionEnd.0.0': claudeHook(['hook', 'claude-code', 'session-end']),
  },
  'plugin/hooks/codex-hooks.json': {
    'SessionStart.0.0': codexHookPair(['hook', 'codex', 'context']),
    'UserPromptSubmit.0.0': codexHookPair(['hook', 'codex', 'session-init']),
    'PreToolUse.0.0': codexHookPair(['hook', 'codex', 'file-context']),
    'PostToolUse.0.0': codexHookPair(['hook', 'codex', 'observation']),
    'Stop.0.0': codexHookPair(['hook', 'codex', 'summarize']),
  },
};

const MCP_EXPECTED = buildShellCommand({
  // The mcp Node launcher derives its module target from requireFile; it ignores
  // trailingCommand, so none is passed (see buildMcpNodeLauncher).
  host: 'mcp', requireFile: 'mcp-server.cjs',
  notFoundMessage: 'claude-mem: mcp server not found',
  mcpExtraCandidates: ['$PWD/plugin', '$PWD'],
  mcpExtraCacheRoots: [
    '$HOME/.codex/plugins/cache/claude-mem-local/claude-mem',
    '$HOME/.codex/plugins/cache/thedotmack/claude-mem',
  ],
});

function hookEntryByPath(parsed: any, dottedPath: string): any | null {
  const [event, groupIdx, hookIdx] = dottedPath.split('.');
  return parsed.hooks?.[event]?.[Number(groupIdx)]?.hooks?.[Number(hookIdx)] ?? null;
}

function hookCommandByPath(parsed: any, dottedPath: string): string | null {
  return hookEntryByPath(parsed, dottedPath)?.command ?? null;
}

describe('Spawn-Contract Templating - Rule A generator parity', () => {
  for (const [filePath, commands] of Object.entries(RULE_A_EXPECTATIONS)) {
    for (const [dottedPath, expected] of Object.entries(commands)) {
      it(`${filePath} [${dottedPath}] equals buildShellCommand output`, () => {
        const parsed = readJson(filePath);
        const entry = hookEntryByPath(parsed, dottedPath);
        const expectedCommand = typeof expected === 'string' ? expected : expected.command;
        expect(entry?.command ?? null).toBe(expectedCommand);
        if (typeof expected !== 'string' && expected.commandWindows !== undefined) {
          expect(entry?.commandWindows ?? null).toBe(expected.commandWindows);
        }
      });
    }
  }

  it('plugin/.mcp.json mcp-search command equals buildShellCommand output', () => {
    const parsed = readJson('plugin/.mcp.json');
    expect(parsed.mcpServers['mcp-search'].args[1]).toBe(MCP_EXPECTED);
  });

  it('bounds the Claude Code UserPromptSubmit hook below the legacy 60 second stall (#3434)', () => {
    const parsed = readJson('plugin/hooks/hooks.json');
    expect(hookEntryByPath(parsed, SESSION_INIT_HOOK_PATH)?.timeout).toBe(SESSION_INIT_HOOK_TIMEOUT_SECONDS);
    // The session-init budget must fit inside the host timeout with room for
    // shell, node and bun startup.
    expect(HOOK_TIMEOUTS.SESSION_INIT_REQUEST_MAX).toBeLessThan(SESSION_INIT_HOOK_TIMEOUT_SECONDS * 1000);
    // Codex keeps its bounded startup (15 s wait + 2 s request) under 20 s.
    const codex = readJson('plugin/hooks/codex-hooks.json');
    expect(hookEntryByPath(codex, SESSION_INIT_HOOK_PATH)?.timeout).toBeGreaterThan(
      (HOOK_TIMEOUTS.POST_SPAWN_WAIT + 2_000) / 1000,
    );
  });

  it('bounds the synchronous Claude Code PreToolUse Read hook below the legacy 60 second stall', () => {
    const parsed = readJson('plugin/hooks/hooks.json');
    const timeoutSeconds = hookEntryByPath(parsed, FILE_CONTEXT_HOOK_PATH)?.timeout;
    expect(timeoutSeconds).toBe(FILE_CONTEXT_HOOK_TIMEOUT_SECONDS);
    // The handler's worker budget must fit inside the host timeout with room
    // for shell, node and bun startup.
    expect(timeoutSeconds).toBeGreaterThan(FILE_CONTEXT_WORKER_BUDGET_MS / 1000 + 5);
  });

  it('never leaks a raw ${CLAUDE_PLUGIN_ROOT} into the resolved trailing command', () => {
    // The placeholder may appear only inside the _E="${CLAUDE_PLUGIN_ROOT:-...}"
    // expansion, never as a bare `${CLAUDE_PLUGIN_ROOT}` token that would reach
    // the binary unsubstituted.
    const shCommands = Object.values(RULE_A_EXPECTATIONS).flatMap((c) =>
      Object.values(c).map((expectation) =>
        typeof expectation === 'string' ? expectation : expectation.command
      )
    );
    for (const command of shCommands) {
      expect(command).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}(?!:-)/);
      expect(command).toContain('_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"');
    }
    // The MCP node launcher reads env vars directly — it has no `${...}` shell
    // tokens at all, so a raw placeholder can never reach the binary.
    expect(MCP_EXPECTED).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(MCP_EXPECTED).toContain('process.env.CLAUDE_PLUGIN_ROOT');
    expect(MCP_EXPECTED).toContain('process.env.PLUGIN_ROOT');
  });
});

describe('Spawn-Contract Templating - Rule A shell resolution matrix', () => {
  // Actually shell-evaluate the generated commands across resolution sources:
  // (a) CLAUDE_PLUGIN_ROOT injected, (b) cache fallback hit, (c) all miss.
  // Replace the trailing exec with `echo "_P=$_P"` so we observe the resolved
  // root without launching node.
  function instrument(command: string): string {
    // Strip everything from the resolved-root guard onward, keep the resolution
    // pipeline, then print _P. We cut at the cygpath clause / trailing command
    // by replacing the not-found guard's exit with a print of _P.
    const cut = command.indexOf('[ -n "$_P" ]');
    const resolution = cut >= 0 ? command.slice(0, cut) : command;
    return `${resolution} echo "RESOLVED=$_P"`;
  }

  const claudeCommands = () => {
    const parsed = readJson('plugin/hooks/hooks.json');
    return Object.entries(RULE_A_EXPECTATIONS['plugin/hooks/hooks.json']).map(
      ([dottedPath]) => ({ dottedPath, command: hookCommandByPath(parsed, dottedPath)! })
    );
  };

  it('resolves _P from CLAUDE_PLUGIN_ROOT when the env var points at a valid root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cm-root-'));
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'version-check.js'), '');
    writeFileSync(path.join(root, 'scripts', 'bun-runner.js'), '');
    writeFileSync(path.join(root, 'scripts', 'worker-service.cjs'), '');
    try {
      for (const { command } of claudeCommands()) {
        const { stdout } = shellEval(instrument(command), {
          CLAUDE_PLUGIN_ROOT: root,
          HOME: mkdtempSync(path.join(tmpdir(), 'cm-home-')),
        });
        expectResolvedPath(stdout, root);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a valid CLAUDE_PLUGIN_ROOT without scanning the plugin cache (#3449, #4121)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cm-root-'));
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    const shimBin = mkdtempSync(path.join(tmpdir(), 'cm-bin-'));
    const cacheScanMarker = path.join(home, 'cache-scan-ran');
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const file of ['version-check.js', 'bun-runner.js', 'worker-service.cjs']) {
      writeFileSync(path.join(root, 'scripts', file), '');
    }
    // Only the cache scan sorts with `sort -r`; the NVM PATH prelude sorts by
    // -t. keys. This shim records `-r` calls and passes input through.
    writeFileSync(
      path.join(shimBin, 'sort'),
      '#!/bin/sh\n[ "$1" = "-r" ] && printf touched > "$CACHE_SCAN_MARKER"\ncat\n',
    );
    chmodSync(path.join(shimBin, 'sort'), 0o755);

    const codexHooks = readJson('plugin/hooks/codex-hooks.json');
    const codexCommands = Object.keys(RULE_A_EXPECTATIONS['plugin/hooks/codex-hooks.json']).map(
      (dottedPath) => ({ dottedPath, command: hookCommandByPath(codexHooks, dottedPath)! }),
    );

    try {
      for (const { dottedPath, command } of [...claudeCommands(), ...codexCommands]) {
        rmSync(cacheScanMarker, { force: true });
        const { status, stdout } = shellEval(instrument(command), {
          CLAUDE_PLUGIN_ROOT: root,
          HOME: home,
          CACHE_SCAN_MARKER: posixPath(cacheScanMarker),
          PATH: `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`,
        });
        expect({ dottedPath, status }).toEqual({ dottedPath, status: 0 });
        expectResolvedPath(stdout, root);
        expect({ dottedPath, cacheScanned: existsSync(cacheScanMarker) }).toEqual({ dottedPath, cacheScanned: false });
      }

      // Control: with an invalid CLAUDE_PLUGIN_ROOT the cache scan still runs,
      // so the shim above would have caught a fast path that never engaged.
      rmSync(cacheScanMarker, { force: true });
      const [{ command: sessionStartCommand }] = claudeCommands().filter(
        ({ dottedPath }) => dottedPath === 'SessionStart.1.0',
      );
      shellEval(instrument(sessionStartCommand), {
        CLAUDE_PLUGIN_ROOT: path.join(home, 'not-a-plugin-root'),
        HOME: home,
        CACHE_SCAN_MARKER: posixPath(cacheScanMarker),
        PATH: `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`,
      });
      expect(existsSync(cacheScanMarker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(shimBin, { recursive: true, force: true });
    }
  });

  it('resolves _P from the cache directory when CLAUDE_PLUGIN_ROOT is unset', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '99.0.0');
    mkdirSync(path.join(cacheRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(cacheRoot, 'scripts', 'version-check.js'), '');
    writeFileSync(path.join(cacheRoot, 'scripts', 'bun-runner.js'), '');
    writeFileSync(path.join(cacheRoot, 'scripts', 'worker-service.cjs'), '');
    try {
      for (const { command } of claudeCommands()) {
        const { stdout } = shellEval(instrument(command), { HOME: home });
        // The version-sort producer yields a trailing slash; the hook trims it
        // via _R="${_R%/}".
        expectResolvedPath(stdout, cacheRoot);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prefers the highest cache version over the newest mtime and skips .orphaned_at dirs (2026-07-22 restart storm)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    const cacheBase = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
    const makeVersion = (version: string) => {
      const root = path.join(cacheBase, version);
      mkdirSync(path.join(root, 'scripts'), { recursive: true });
      for (const file of ['version-check.js', 'bun-runner.js', 'worker-service.cjs']) {
        writeFileSync(path.join(root, 'scripts', file), '');
      }
      return root;
    };
    // The storm layout: the OLD version dir carries the .orphaned_at stamp and
    // the newest mtime; the NEW version dir is older by mtime. The resolver
    // must pick the new version anyway.
    const oldRoot = makeVersion('13.11.0');
    writeFileSync(path.join(oldRoot, '.orphaned_at'), String(Date.now()));
    const newRoot = makeVersion('13.12.0');
    const past = new Date(Date.now() - 600_000);
    utimesSync(newRoot, past, past);
    try {
      for (const { command } of claudeCommands()) {
        const { stdout } = shellEval(instrument(command), { HOME: home });
        expectResolvedPath(stdout, newRoot);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps Setup fail-loud while runtime hooks fail open when no candidate exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-empty-'));
    try {
      const parsed = readJson('plugin/hooks/hooks.json');
      const setupCommand = hookCommandByPath(parsed, 'Setup.0.0')!;
      const setupResult = shellEval(setupCommand, { HOME: home });
      expect(setupResult.status).not.toBe(0);
      expect(setupResult.stderr).toMatch(/claude-mem: .* not found/);

      const runtimeCommand = hookCommandByPath(parsed, 'UserPromptSubmit.0.0')!;
      const runtimeResult = shellEval(runtimeCommand, { HOME: home });
      expect(runtimeResult.status).toBe(0);
      expect(runtimeResult.stderr).toMatch(/claude-mem: .* not found/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps runtime hooks fail-open when the resolved command exits non-zero (#3412)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-command-fail-'));
    const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '99.0.0');
    mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'scripts', 'bun-runner.js'), 'process.exit(7);\n');
    writeFileSync(path.join(pluginRoot, 'scripts', 'worker-service.cjs'), '');

    try {
      const parsed = readJson('plugin/hooks/hooks.json');
      const runtimeCommand = hookCommandByPath(parsed, 'UserPromptSubmit.0.0')!;
      const runtimeResult = shellEval(runtimeCommand, { HOME: home });

      expect(runtimeResult.status).toBe(0);
      expect(runtimeResult.stderr).toContain('claude-mem: hook command failed (exit 7)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prepends the highest NVM node bin to PATH without login shell (#3190)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-nvm-only-'));
    installFakeNvmNode(home, '18.20.0');
    const newestBin = installFakeNvmNode(home, '20.11.0');
    const prelude = claudePathPreludeFrom(commandHooksFrom('plugin/hooks/hooks.json')[0]);
    try {
      const { status, stdout } = shellEval(`${prelude} printf '%s' "$PATH"`, {
        HOME: home,
        PATH: '/usr/bin:/bin',
      });
      expect(status).toBe(0);
      expect(normalizeShellPath((stdout ?? '').split(':')[0])).toBe(normalizeShellPath(newestBin));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Spawn-Contract Templating - Rule B installers bake absolute paths', () => {
  const installerFiles = [
    'src/services/integrations/CursorHooksInstaller.ts',
    'src/services/integrations/WindsurfHooksInstaller.ts',
    'src/services/integrations/McpIntegrations.ts',
    'src/services/integrations/AntigravityCliHooksInstaller.ts',
  ];

  for (const file of installerFiles) {
    it(`${file} emits no raw \${CLAUDE_PLUGIN_ROOT} placeholder`, () => {
      const content = readFileSync(path.join(projectRoot, file), 'utf-8');
      expect(content).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
    });
  }

  it('install-paths.ts centralizes the Rule B helpers', () => {
    const content = readFileSync(
      path.join(projectRoot, 'src/services/integrations/install-paths.ts'),
      'utf-8',
    );
    for (const name of [
      'getMcpServerAbsolutePath',
      'getWorkerServiceAbsolutePath',
      'getBunAbsolutePath',
      'getNodeAbsolutePath',
      'getPluginRootAbsolutePath',
    ]) {
      expect(content).toContain(`export function ${name}`);
    }
  });
});
