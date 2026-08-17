import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildClaudeNodeHook, buildCodexWindowsCommand, buildShellCommand } from '../../src/build/hook-shell-template.js';

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
    expect(codexHooks.hooks.SessionStart[0].hooks[0].commandWindows).toContain('version-check.js');
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

describe('Plugin Distribution - hooks.json Integrity', () => {
  it('should have valid JSON in hooks.json', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeDefined();
  });

  it('should reference CLAUDE_PLUGIN_ROOT in all Claude hook launchers', () => {
    for (const entry of commandHookEntriesFrom('plugin/hooks/hooks.json')) {
      expect(entry.args?.[1]).toContain('process.env.CLAUDE_PLUGIN_ROOT');
    }
  });

  it('should include the marketplace fallback in all Claude hook launchers (#1215)', () => {
    const expectedFallbackPath = "plugins','marketplaces','thedotmack','plugin";

    for (const entry of commandHookEntriesFrom('plugin/hooks/hooks.json')) {
      expect(entry.args?.[1]).toContain(expectedFallbackPath);
    }
  });

  it('should try cache path before marketplace fallback in all Claude hook launchers (#1533)', () => {
    const cachePath = "plugins','cache','thedotmack','claude-mem";
    const marketplacesPath = "plugins','marketplaces','thedotmack','plugin";

    for (const entry of commandHookEntriesFrom('plugin/hooks/hooks.json')) {
      const payload = entry.args?.[1] ?? '';
      expect(payload).toContain(cachePath);
      expect(payload.indexOf(cachePath)).toBeLessThan(payload.indexOf(marketplacesPath));
    }
  });
});

describe('Plugin Distribution - Startup Root Resolution', () => {
  it('MCP startup command resolves the plugin root cross-platform (#2792)', () => {
    // The launcher is now a cross-platform `node -e` payload (no `sh`), so it
    // spawns on Windows without Git Bash. It must still resolve the plugin root
    // with config-dir + env fallbacks and try cache roots before marketplaces.
    const command = mcpStartupCommandFrom('plugin/.mcp.json');

    expect(command).toContain('CLAUDE_CONFIG_DIR');
    expect(command).toContain('.claude');
    expect(command).toContain('CLAUDE_PLUGIN_ROOT');
    expect(command).toContain('PLUGIN_ROOT');
    expect(command).toContain('plugins/marketplaces/thedotmack/plugin');
    expect(command).toContain('plugins/cache/thedotmack/claude-mem');
    expect(command).toContain('mcp-server.cjs');
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
    for (const entry of commandHookEntriesFrom('plugin/hooks/hooks.json')) {
      expect(entry.command).toBe('node');
      expect(entry.args?.[1]).toContain('process.env.CLAUDE_PLUGIN_ROOT');
      expect(entry.args?.[1]).toContain("plugins','cache','thedotmack','claude-mem");
      expect(entry.args?.[1]).toContain("plugins','marketplaces','thedotmack','plugin");
    }
  });
});

describe('Plugin Distribution - package.json Files Field', () => {
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

  it('npm tarball includes sqlite runtime modules required by the worker', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const packed = JSON.parse(result.stdout);
    const filePaths = new Set(packed[0].files.map((file: { path: string }) => file.path));

    expect(filePaths.has('plugin/sqlite/SessionStore.js')).toBe(true);
    expect(filePaths.has('plugin/sqlite/observations/files.js')).toBe(true);
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
      h.args?.[1]?.includes('version-check.js')
    );
    expect(versionCheckHooks.length).toBeGreaterThan(0);
  });

  it('version-check.js referenced by Setup hook should exist on disk', () => {
    const versionCheckPath = path.join(projectRoot, 'plugin/scripts/version-check.js');
    expect(existsSync(versionCheckPath)).toBe(true);
  });
});

describe('Plugin Distribution - Non-blocking bookkeeping hooks (#3206)', () => {
  it('runs observation, file context, and summarization asynchronously', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const postToolUse = parsed.hooks.PostToolUse[0].hooks[0];
    const preToolUse = parsed.hooks.PreToolUse[0].hooks[0];
    const stop = parsed.hooks.Stop[0].hooks[0];

    expect(postToolUse.args?.[1]).toContain('observation');
    expect(postToolUse.async).toBe(true);
    expect(preToolUse.args?.[1]).toContain('file-context');
    expect(preToolUse.async).toBe(true);
    expect(stop.args?.[1]).toContain('summarize');
    expect(stop.async).toBe(true);
  });

  it('generates all seven Claude hooks as direct Node exec entries (#3396)', () => {
    const claudeCommandHooks = commandHookEntriesFrom('plugin/hooks/hooks.json');
    expect(claudeCommandHooks).toHaveLength(7);
    for (const hook of claudeCommandHooks) {
      expect(hook.command).toBe('node');
      expect(hook.args?.[0]).toBe('-e');
      expect(hook.args?.[1]).toContain('windowsHide:true');
      expect(hook.args?.[1]).toContain('ch.kill(s)');
      expect(hook.shell).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Spawn-contract templating (plans/02-spawn-contract-templating.md)
// ---------------------------------------------------------------------------

const ccTrailing = (...tail: string[]) => [
  'node', '"$_P/scripts/bun-runner.js"', '"$_P/scripts/worker-service.cjs"', ...tail,
];
const codexHook = (tail: string[]) => buildShellCommand({
  host: 'codex-cli', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
  trailingCommand: ccTrailing(...tail), notFoundMessage: 'claude-mem: plugin scripts not found',
  extraEnv: { CLAUDE_MEM_CODEX_HOOK: '1' },
});
const codexStartupHook = () => buildShellCommand({
  host: 'codex-cli', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
  trailingCommand: [
    '_V=$(CLAUDE_MEM_CODEX_HOOK=1 node "$_P/scripts/version-check.js" || true);',
    'if [ -n "$_V" ]; then printf \'%s\\n\' "$_V"; else',
    'CLAUDE_MEM_CODEX_HOOK=1', ...ccTrailing('hook', 'codex', 'context'),
    '; fi',
  ],
  notFoundMessage: 'claude-mem: plugin scripts not found',
});
const codexHookPair = (tail: string[], options: { startupVersionCheck?: boolean } = {}) => ({
  command: options.startupVersionCheck ? codexStartupHook() : codexHook(tail),
  commandWindows: buildCodexWindowsCommand(tail, options),
});

const claudeNodeHook = (tail: string[]) => buildClaudeNodeHook({
    requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs',
    scriptPathArg: 'worker-service.cjs', scriptArgs: tail,
    notFoundMessage: 'claude-mem: plugin scripts not found',
  });
const claudeSetupNodeHook = () => buildClaudeNodeHook({
    requireFile: 'version-check.js', scriptArgs: [],
    notFoundMessage: 'claude-mem: version-check.js not found',
  });

type RuleAExpectation = string | { command: string; args?: string[]; commandWindows?: string };

const RULE_A_EXPECTATIONS: Record<string, Record<string, RuleAExpectation>> = {
  'plugin/hooks/hooks.json': {
    'Setup.0.0': claudeSetupNodeHook(),
    // `start` already prints its own single, valid status JSON
    // (buildStatusOutput → {"continue":true,"status":"ready","suppressOutput":true}),
    // so NO trailingJson echo is appended — a second echoed object would
    // concatenate two JSON documents on stdout, which Claude Code cannot parse,
    // causing it to ignore suppressOutput and render the raw JSON at the top of
    // every session.
    'SessionStart.0.0': claudeNodeHook(['start']),
    'SessionStart.0.1': claudeNodeHook(['hook', 'claude-code', 'context']),
    'UserPromptSubmit.0.0': claudeNodeHook(['hook', 'claude-code', 'session-init']),
    'PostToolUse.0.0': claudeNodeHook(['hook', 'claude-code', 'observation']),
    'PreToolUse.0.0': claudeNodeHook(['hook', 'claude-code', 'file-context']),
    'Stop.0.0': claudeNodeHook(['hook', 'claude-code', 'summarize']),
  },
  'plugin/hooks/codex-hooks.json': {
    'SessionStart.0.0': codexHookPair(['hook', 'codex', 'context'], { startupVersionCheck: true }),
    'UserPromptSubmit.0.0': codexHookPair(['hook', 'codex', 'session-init']),
    'PreToolUse.0.0': codexHookPair(['hook', 'codex', 'file-context']),
    'PostToolUse.0.0': codexHookPair(['hook', 'codex', 'observation']),
    'Stop.0.0': codexHookPair(['hook', 'codex', 'summarize']),
  },
};

const MCP_EXPECTED = buildShellCommand({
  // The mcp Node launcher derives its spawn target from requireFile; it ignores
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

describe('Spawn-Contract Templating - Rule A generator parity', () => {
  for (const [filePath, commands] of Object.entries(RULE_A_EXPECTATIONS)) {
    for (const [dottedPath, expected] of Object.entries(commands)) {
      it(`${filePath} [${dottedPath}] equals buildShellCommand output`, () => {
        const parsed = readJson(filePath);
        const entry = hookEntryByPath(parsed, dottedPath);
        const expectedCommand = typeof expected === 'string' ? expected : expected.command;
        expect(entry?.command ?? null).toBe(expectedCommand);
        if (typeof expected !== 'string') {
          if (expected.args) expect(entry?.args ?? null).toEqual(expected.args);
          if (expected.commandWindows) expect(entry?.commandWindows ?? null).toBe(expected.commandWindows);
          if (expected.args) expect(entry?.shell).toBeUndefined();
        }
      });
    }
  }

  it('plugin/.mcp.json mcp-search command equals buildShellCommand output', () => {
    const parsed = readJson('plugin/.mcp.json');
    expect(parsed.mcpServers['mcp-search'].args[1]).toBe(MCP_EXPECTED);
  });

  it('never leaks a raw ${CLAUDE_PLUGIN_ROOT} into the resolved trailing command', () => {
    // The placeholder may appear only inside the _E="${CLAUDE_PLUGIN_ROOT:-...}"
    // expansion, never as a bare `${CLAUDE_PLUGIN_ROOT}` token that would reach
    // the binary unsubstituted.
    const shCommands = Object.values(RULE_A_EXPECTATIONS).flatMap((c) =>
      Object.values(c).map((expectation) =>
        typeof expectation === 'string' ? expectation : expectation.command
      )
    ).filter((command) => command !== 'node');
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

  it('preserves all non-launch metadata for all seven Claude hooks', () => {
    const parsed = readJson('plugin/hooks/hooks.json');
    const expected: Record<string, { matcher?: string; timeout: number; async?: boolean }> = {
      'Setup.0.0': { matcher: '*', timeout: 300 },
      'SessionStart.0.0': { matcher: 'startup|clear|compact', timeout: 60 },
      'SessionStart.0.1': { matcher: 'startup|clear|compact', timeout: 60 },
      'UserPromptSubmit.0.0': { timeout: 60 },
      'PostToolUse.0.0': { matcher: '*', timeout: 120, async: true },
      'PreToolUse.0.0': { matcher: 'Read', timeout: 60, async: true },
      'Stop.0.0': { timeout: 120, async: true },
    };
    for (const [dottedPath, metadata] of Object.entries(expected)) {
      const [event, groupIdx] = dottedPath.split('.');
      const matcher = parsed.hooks[event][Number(groupIdx)];
      const entry = hookEntryByPath(parsed, dottedPath);
      expect(matcher.matcher).toBe(metadata.matcher);
      expect(entry.type).toBe('command');
      expect(entry.timeout).toBe(metadata.timeout);
      expect(entry.async).toBe(metadata.async);
    }
  });
});

describe('Spawn-Contract Templating - Rule A Claude exec resolution matrix', () => {
  const claudeEntries = () => {
    const parsed = readJson('plugin/hooks/hooks.json');
    return Object.entries(RULE_A_EXPECTATIONS['plugin/hooks/hooks.json']).map(
      ([dottedPath]) => ({ dottedPath, entry: hookEntryByPath(parsed, dottedPath)! })
    );
  };

  const expectedWorkerArgs: Record<string, string[]> = {
    'Setup.0.0': [],
    'SessionStart.0.0': ['worker-service.cjs', 'start'],
    'SessionStart.0.1': ['worker-service.cjs', 'hook', 'claude-code', 'context'],
    'UserPromptSubmit.0.0': ['worker-service.cjs', 'hook', 'claude-code', 'session-init'],
    'PostToolUse.0.0': ['worker-service.cjs', 'hook', 'claude-code', 'observation'],
    'PreToolUse.0.0': ['worker-service.cjs', 'hook', 'claude-code', 'file-context'],
    'Stop.0.0': ['worker-service.cjs', 'hook', 'claude-code', 'summarize'],
  };

  function makeRoot(root: string): void {
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const script = "process.stdout.write(JSON.stringify({root:__dirname,args:process.argv.slice(2)}));";
    writeFileSync(path.join(root, 'scripts', 'version-check.js'), script);
    writeFileSync(path.join(root, 'scripts', 'bun-runner.js'), script);
    writeFileSync(path.join(root, 'scripts', 'worker-service.cjs'), '');
  }

  function runEntry(entry: any, env: Record<string, string>) {
    return spawnSync(entry.command, entry.args, {
      env: { PATH: process.env.PATH ?? '', ...env, USERPROFILE: env.USERPROFILE ?? env.HOME ?? process.env.USERPROFILE },
      encoding: 'utf-8',
    });
  }

  it('resolves _P from CLAUDE_PLUGIN_ROOT when the env var points at a valid root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cm-root-'));
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    makeRoot(path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '99.0.0'));
    makeRoot(root);
    try {
      for (const { dottedPath, entry } of claudeEntries()) {
        const { stdout, status } = runEntry(entry, {
          CLAUDE_PLUGIN_ROOT: root,
          HOME: home,
        });
        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          root: path.join(root, 'scripts'),
          args: expectedWorkerArgs[dottedPath].map((arg) =>
            arg === 'worker-service.cjs' ? path.join(root, 'scripts', arg) : arg
          ),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves _P from the cache directory when CLAUDE_PLUGIN_ROOT is unset', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '99.0.0');
    makeRoot(cacheRoot);
    makeRoot(path.join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin'));
    try {
      for (const { dottedPath, entry } of claudeEntries()) {
        const { stdout, status } = runEntry(entry, { HOME: home });
        expect(status).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          root: path.join(cacheRoot, 'scripts'),
          args: expectedWorkerArgs[dottedPath].map((arg) =>
            arg === 'worker-service.cjs' ? path.join(cacheRoot, 'scripts', arg) : arg
          ),
        });
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
      makeRoot(root);
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
      for (const { entry } of claudeEntries()) {
        const { stdout, status } = runEntry(entry, { HOME: home });
        expect(status).toBe(0);
        expect(JSON.parse(stdout).root).toBe(path.join(newRoot, 'scripts'));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to the marketplace plugin root', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-marketplace-'));
    const root = path.join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin');
    makeRoot(root);
    try {
      const entry = hookEntryByPath(readJson('plugin/hooks/hooks.json'), 'Setup.0.0');
      const result = runEntry(entry, { HOME: home });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).root).toBe(path.join(root, 'scripts'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails cleanly with the canonical not-found message when no candidate exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'cm-empty-'));
    try {
      const parsed = readJson('plugin/hooks/hooks.json');
      const entry = hookEntryByPath(parsed, 'UserPromptSubmit.0.0');
      const result = runEntry(entry, { HOME: home });
      expect(result.status).not.toBe(0);
      expect(result.stderr ?? '').toMatch(/claude-mem: .* not found/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('propagates child stderr and non-zero exit status', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cm-child-failure-'));
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'bun-runner.js'), "process.stderr.write('runner failed\\n');process.exit(7);");
    writeFileSync(path.join(root, 'scripts', 'worker-service.cjs'), '');
    try {
      const entry = hookEntryByPath(readJson('plugin/hooks/hooks.json'), 'UserPromptSubmit.0.0');
      const result = runEntry(entry, { CLAUDE_PLUGIN_ROOT: root, HOME: mkdtempSync(path.join(tmpdir(), 'cm-home-')) });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain('runner failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards termination signals to the resolved Claude child', async () => {
    const entry = hookEntryByPath(readJson('plugin/hooks/hooks.json'), 'UserPromptSubmit.0.0');
    if (process.platform === 'win32') {
      expect(entry.args?.[1]).toContain("['SIGTERM','SIGINT','SIGHUP']");
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), 'cm-child-signal-'));
    const home = mkdtempSync(path.join(tmpdir(), 'cm-home-'));
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, 'scripts', 'bun-runner.js'),
      "process.on('SIGTERM',()=>{process.stdout.write('signal-received');process.exit(0)});setInterval(()=>{},1000);",
    );
    writeFileSync(path.join(root, 'scripts', 'worker-service.cjs'), '');
    let stdout = '';
    try {
      const child = spawn(entry.command, entry.args, {
        env: { PATH: process.env.PATH ?? '', CLAUDE_PLUGIN_ROOT: root, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Claude launcher did not exit after forwarding SIGTERM'));
        }, 5000);
        const signalTimer = setTimeout(() => child.kill('SIGTERM'), 100);
        child.once('error', (error) => {
          clearTimeout(timeout);
          clearTimeout(signalTimer);
          reject(error);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timeout);
          clearTimeout(signalTimer);
          resolve({ code, signal });
        });
      });
      expect(outcome.code).toBe(0);
      expect(stdout).toContain('signal-received');
    } finally {
      rmSync(root, { recursive: true, force: true });
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
