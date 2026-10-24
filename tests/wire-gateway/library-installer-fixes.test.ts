import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { INSTALLER_NODE_PATH_ENV, getNodeAbsolutePath } from '../../src/services/integrations/install-paths.js';
import { describeLibraryChildFailure, libraryChildEnvironment } from '../../src/npx-cli/commands/library.js';
import { LIBRARY_INSTALL_MCP_STEP_FAILED_EXIT_CODE } from '../../src/services/wire-gateway/library/types.js';

// The Phase 14 review fixes, through the installers themselves. Every
// scenario runs in a child process with a sandboxed HOME, cwd and data dir,
// so no real agent config is ever read or written.

const SANDBOX_PARENT = join(WIRE_GATEWAY_DIR, 'tmp', `library-installer-fixes-${process.pid}`);
const SCENARIO_SCRIPT = join(import.meta.dir, 'library', 'fix-scenarios.ts');
const WORKER_SERVICE_SOURCE = join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts');
/** A scenario child starts Bun and runs one or two installers, about a second; the bound reports a hang on a loaded CI box. */
const SCENARIO_TIMEOUT_MS = 60_000;

mkdirSync(SANDBOX_PARENT, { recursive: true });
afterAll(() => rmSync(SANDBOX_PARENT, { recursive: true, force: true }));
let sandboxCounter = 0;

function makeSandbox(name: string): string {
  const root = join(SANDBOX_PARENT, `${name}-${sandboxCounter++}`);
  for (const directory of ['home', 'workspace', 'data', 'bin', 'tmp']) mkdirSync(join(root, directory), { recursive: true });
  return root;
}

function sandboxEnvironment(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
    TMPDIR: join(root, 'tmp'),
    CLAUDE_MEM_DATA_DIR: join(root, 'data'),
    CLAUDE_PLUGIN_ROOT: join(root, 'home', '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin'),
    // Port 1 refuses at once: no installer step reaches a real worker.
    CLAUDE_MEM_WORKER_PORT: '1',
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    LANG: 'C.UTF-8',
    GIT_CEILING_DIRECTORIES: SANDBOX_PARENT,
    ...extra,
  };
}

interface ScenarioResult {
  exitCodes: number[];
  files: Record<string, string | null>;
  output: string[];
}

function runScenario(scenario: string, extraEnvironment: Record<string, string> = {}): ScenarioResult {
  const root = makeSandbox(scenario);
  const resultPath = join(root, 'result.json');
  const child = spawnSync(process.execPath, [SCENARIO_SCRIPT, scenario, root, resultPath], {
    cwd: join(root, 'workspace'),
    env: sandboxEnvironment(root, extraEnvironment),
    encoding: 'utf-8',
    timeout: SCENARIO_TIMEOUT_MS,
  });
  if (child.status !== 0) throw new Error(`scenario ${scenario} failed (status ${child.status}, signal ${child.signal}):\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(readFileSync(resultPath, 'utf-8')) as ScenarioResult;
}

describe('uninstall after upgrading from a pre-Library install leaves nothing of claude-mem active (P1)', () => {
  it('Kimi: the old hook block at a dead path does not come back', () => {
    const result = runScenario('kimi-upgrade-uninstall');
    expect(result.exitCodes).toEqual([0, 0, 0]);
    expect(result.files.config).toBe('default_model = "k2"\n');
  });

  it('OpenClaw: the memory slot and plugin entry go with the extension folder', () => {
    const result = runScenario('openclaw-upgrade-uninstall');
    expect(result.exitCodes).toEqual([0, 0]);
    expect(JSON.parse(result.files.config!)).toEqual({ gateway: { port: 1 }, plugins: { slots: {}, entries: {} } });
    expect(result.files.extensionIndex).toBeNull();
  });

  it('Codex: claude-mem\'s plugins are left off, the legacy id included, as uninstall always left them', () => {
    const result = runScenario('codex-upgrade-uninstall');
    expect(result.exitCodes).toEqual([0]);
    const config = Bun.TOML.parse(result.files.config!) as { plugins: Record<string, { enabled: boolean }>; features: { hooks: boolean } };
    expect(config.plugins['claude-mem@claude-mem-local'].enabled).toBe(false);
    expect(config.plugins['claude-mem@thedotmack'].enabled).toBe(false);
    expect(config.features.hooks).toBe(true);
  });

  it('Antigravity: no empty `claude-mem` hook is left after an adopted install is removed', () => {
    const result = runScenario('antigravity-upgrade-uninstall');
    expect(result.exitCodes).toEqual([0, 0]);
    expect(JSON.parse(result.files.hooks!)).toEqual({ 'my-guard': { Stop: [{ type: 'command', command: './guard.sh' }] } });
  });
});

describe('a remove never needs the plugin folder (P2)', () => {
  it('Cursor: uninstall with the plugin gone succeeds and takes out the pre-Library hook and MCP entry', () => {
    const result = runScenario('cursor-remove-without-plugin');
    expect(result.exitCodes).toEqual([0]);
    expect(JSON.parse(result.files.hooks!).hooks.stop).toEqual([{ command: './mine.sh' }]);
    expect(JSON.parse(result.files.mcp!).mcpServers).toEqual({ github: { command: 'gh' } });
  });

  it('Kimi: the pre-Library hook block and mcp-search go', () => {
    const result = runScenario('kimi-remove-without-plugin');
    expect(result.exitCodes).toEqual([0]);
    expect(result.files.config).toBe('default_model = "k2"\n');
    expect(JSON.parse(result.files.mcp!).mcpServers).toEqual({ github: { command: 'gh' } });
  });

  it('Windsurf: the pre-Library hook goes', () => {
    const result = runScenario('windsurf-remove-without-plugin');
    expect(result.exitCodes).toEqual([0]);
    expect(JSON.parse(result.files.hooks!).hooks.pre_user_prompt).toEqual([{ command: './audit.sh', show_output: true }]);
  });

  it('Antigravity: the pre-Library named hook and MCP entry go, with no empty `claude-mem` left', () => {
    const result = runScenario('antigravity-remove-without-plugin');
    expect(result.exitCodes).toEqual([0]);
    expect(JSON.parse(result.files.hooks!)).toEqual({ 'my-guard': { Stop: [{ type: 'command', command: './guard.sh' }] } });
    expect(JSON.parse(result.files.mcp!).mcpServers).toEqual({ github: { command: 'gh' } });
  });
});

describe('uninstall reports what it did (P3)', () => {
  it('OpenClaw says there was no extension to remove when there was none', () => {
    const result = runScenario('openclaw-uninstall-nothing-installed');
    expect(result.exitCodes).toEqual([0]);
    expect(result.output.join('\n')).not.toContain('Removed extension');
    expect(result.output.join('\n')).toContain('No claude-mem extension files to remove');
  });

  it('Kimi\'s install exits with its own code when only the MCP half fails, so the npx installer names the right half', () => {
    const result = runScenario('kimi-install-mcp-step-fails');
    expect(result.exitCodes).toEqual([LIBRARY_INSTALL_MCP_STEP_FAILED_EXIT_CODE]);
    expect(result.files.config).toBe('written');
  });

  it('a Library child that did not finish is reported by its real cause', () => {
    const timedOut = Object.assign(new Error('spawnSync bun ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const overflowed = Object.assign(new Error('spawnSync bun ENOBUFS'), { code: 'ENOBUFS' });
    expect(describeLibraryChildFailure(['install', 'kimi'], { error: timedOut })).toBe('claude-mem library install kimi did not finish within 10 minutes and was stopped');
    expect(describeLibraryChildFailure(['install', 'kimi'], { error: overflowed })).toBe('claude-mem library install kimi could not run: spawnSync bun ENOBUFS');
    expect(describeLibraryChildFailure(['uninstall', 'cursor'], { signal: 'SIGKILL' })).toBe('claude-mem library uninstall cursor was killed by SIGKILL');
  });
});

describe('the double-context guard at the installers\' call sites (task 5)', () => {
  it('Antigravity writes no context block when its wire route injects memory', () => {
    const result = runScenario('antigravity-wire-injects');
    expect(result.exitCodes).toEqual([0]);
    expect(result.files.hooks).toBe('written');
    expect(result.files.geminiMd).toBeNull();
    expect(result.files.rules).toBeNull();
  });

  it('an MCP-only agent (Roo Code) writes no context block when its wire route injects memory', () => {
    const result = runScenario('roo-code-wire-injects');
    expect(result.exitCodes).toEqual([0]);
    expect(result.files.mcp).not.toBeNull();
    expect(result.files.rules).toBeNull();
  });
});

describe('the MCP server\'s Node under npx (P2)', () => {
  it('the npx CLI hands its Node to the Bun child, and the child registers the MCP server with it', () => {
    expect(libraryChildEnvironment({ PATH: '/usr/bin' }, '/opt/node/bin/node')[INSTALLER_NODE_PATH_ENV]).toBe('/opt/node/bin/node');
    const result = runScenario('copilot-mcp-node-under-npx', { [INSTALLER_NODE_PATH_ENV]: '/opt/node/bin/node' });
    expect(result.exitCodes).toEqual([0]);
    expect(JSON.parse(result.files.mcp!).servers['claude-mem'].command).toBe('/opt/node/bin/node');
  });

  it('without the npx parent, the installing process\'s own runtime is used, as before', () => {
    const saved = process.env[INSTALLER_NODE_PATH_ENV];
    delete process.env[INSTALLER_NODE_PATH_ENV];
    try {
      expect(getNodeAbsolutePath()).toBe(process.execPath);
    } finally {
      if (saved !== undefined) process.env[INSTALLER_NODE_PATH_ENV] = saved;
    }
  });
});

describe('`claude-mem library sync|remove` through the CLI, started as the launcher starts it (P2)', () => {
  it('acts on the caller\'s project, not the neutral directory Bun starts in', () => {
    const root = makeSandbox('cli-roo-code');
    const marketplacePlugin = join(root, 'home', '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'scripts');
    mkdirSync(marketplacePlugin, { recursive: true });
    writeFileSync(join(marketplacePlugin, 'mcp-server.cjs'), '// mcp\n');
    writeFileSync(join(marketplacePlugin, 'worker-service.cjs'), '// worker\n');
    const workspace = join(root, 'workspace');
    // The launcher starts Bun in the OS temp dir and passes the caller's directory here (claude-mem-launcher.ts).
    const run = (subcommand: string) => spawnSync(process.execPath, [WORKER_SERVICE_SOURCE, 'library', subcommand, 'roo-code'], {
      cwd: join(root, 'tmp'),
      env: sandboxEnvironment(root, { CLAUDE_MEM_HOOK_ORIGINAL_CWD: workspace }),
      encoding: 'utf-8',
      timeout: SCENARIO_TIMEOUT_MS,
    });
    const sync = run('sync');
    expect({ status: sync.status, stderr: sync.stderr.includes('Installation failed') }).toEqual({ status: 0, stderr: false });
    expect(existsSync(join(workspace, '.roo', 'mcp.json'))).toBe(true);
    expect(existsSync(join(root, 'tmp', '.roo'))).toBe(false);
    expect(JSON.parse(readFileSync(join(workspace, '.roo', 'mcp.json'), 'utf-8')).mcpServers['claude-mem']).toBeDefined();

    const remove = run('remove');
    expect(remove.status).toBe(0);
    expect(existsSync(join(workspace, '.roo', 'mcp.json'))).toBe(false);
    expect(existsSync(join(workspace, '.roo', 'rules', 'claude-mem-context.md'))).toBe(false);
  }, SCENARIO_TIMEOUT_MS);
});
