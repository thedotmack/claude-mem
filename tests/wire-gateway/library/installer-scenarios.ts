// Runs one installer scenario inside a sandboxed HOME and writes a snapshot
// of every file the installers touched (plan Phase 14 task 4: golden outputs
// taken from the installers, then reproduced byte for byte by the Library
// engine). Started as a child process by golden-harness.ts: Bun reads HOME
// once per process, and the installers resolve their paths from homedir()
// and process.cwd() at import time, so a sandbox needs its own process.
//
//   bun installer-scenarios.ts <scenario> <sandboxRoot> <snapshotOutPath>
//
// The sandbox is laid out by the harness: <root>/home is HOME,
// <root>/workspace is the cwd, <root>/data is CLAUDE_MEM_DATA_DIR and
// <root>/bin holds fake agent CLIs. Only the installers' public functions
// are called, so the same scenario runs against the old installers (to take
// the goldens) and the ported ones (to prove parity).

import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';

const [scenarioName, sandboxRoot = '', snapshotOutPath] = process.argv.slice(2);

const home = join(sandboxRoot, 'home');
const workspace = join(sandboxRoot, 'workspace');
const dataDir = join(sandboxRoot, 'data');
const binDir = join(sandboxRoot, 'bin');
const marketplace = join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack');

function write(path: string, text: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

function fakeCli(name: string, script: string): void {
  write(join(binDir, name), `#!/bin/sh\n${script}\n`, 0o755);
}

/** The installed plugin tree every installer looks for: scripts, bundles, manifests. */
function seedMarketplace(): void {
  write(join(home, '.bun', 'bin', 'bun'), '', 0o755);
  write(join(marketplace, 'plugin', 'scripts', 'worker-service.cjs'), '// worker\n');
  write(join(marketplace, 'plugin', 'scripts', 'mcp-server.cjs'), '// mcp\n');
  write(join(marketplace, 'plugin', '.claude-plugin', 'plugin.json'), '{"name":"claude-mem"}\n');
  write(join(marketplace, 'plugin', '.codex-plugin', 'plugin.json'), '{"name":"claude-mem"}\n');
  write(join(marketplace, 'plugin', '.mcp.json'), '{}\n');
  write(join(marketplace, 'plugin', 'hooks', 'codex-hooks.json'), '{}\n');
  write(join(marketplace, 'plugin', 'hooks', 'hooks.json'), '{}\n');
  write(join(marketplace, 'plugin', 'skills', 'mem-search', 'SKILL.md'), '# mem-search\n');
  write(join(marketplace, '.claude-plugin', 'marketplace.json'), '{"name":"thedotmack"}\n');
  write(join(marketplace, '.agents', 'plugins', 'marketplace.json'), '{"name":"claude-mem-local"}\n');
  write(join(marketplace, 'dist', 'opencode-plugin', 'index.js'), 'export default { id: "claude-mem" };\n');
  write(join(marketplace, 'omp', 'hooks', 'claude-mem.ts'), 'export default function hook() {}\n');
  write(join(marketplace, 'openclaw', 'dist', 'index.js'), 'export default {};\n');
  write(join(marketplace, 'openclaw', 'dist', 'chunk.js'), 'export const chunk = 1;\n');
  write(join(marketplace, 'openclaw', 'openclaw.plugin.json'), '{"id":"claude-mem"}\n');
  write(join(marketplace, 'openclaw', 'skills', 'memory', 'SKILL.md'), '# memory skill\n');
  // Pi: the bundle, and attribution texts that must equal the package's own.
  const typeboxLicense = 'MIT License (typebox)\n';
  const attribution: Array<[string, string]> = [
    ['LICENSE.txt', 'pi third-party license\n'],
    ['CLAUDE-MEM-LICENSE.txt', 'claude-mem license\n'],
    ['CLAUDE-MEM-NOTICE.txt', 'claude-mem notice\n'],
    ['TYPEBOX-LICENSE.txt', typeboxLicense],
    ['TYPEBOX-PROVENANCE.json', JSON.stringify({ name: 'typebox', version: '1.1.24', license: 'MIT', licenseSha256: createHash('sha256').update(typeboxLicense).digest('hex') })],
  ];
  write(join(marketplace, 'pi', 'THIRD-PARTY-LICENSE.txt'), attribution[0][1]);
  write(join(marketplace, 'LICENSE'), attribution[1][1]);
  write(join(marketplace, 'NOTICE'), attribution[2][1]);
  write(join(marketplace, 'pi', 'TYPEBOX-LICENSE.txt'), attribution[3][1]);
  write(join(marketplace, 'pi', 'TYPEBOX-PROVENANCE.json'), attribution[4][1]);
  write(join(marketplace, 'dist', 'pi-extension', 'index.js'), 'export default function pi() {}\n');
  for (const [name, text] of attribution) write(join(marketplace, 'dist', 'pi-extension', name), text);
  // DSH package.
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt']) write(join(marketplace, 'dsh', file), `${file}\n`);
  write(join(marketplace, 'dsh', 'package.json'), '{"name":"@claude-mem/dsh"}\n');
  write(join(marketplace, 'dsh', 'lib', 'index.js'), 'module.exports = {};\n');
  write(join(marketplace, 'dsh', 'transcript-schema.json'), JSON.stringify({ name: 'dsh', version: '1', events: [] }));
}

function seedFakeClis(): void {
  const callLog = join(sandboxRoot, 'cli-calls.log');
  fakeCli('codex', [
    `echo "codex $*" >> "${callLog}"`,
    'case "$1" in',
    '  --version) echo "codex-cli 0.130.0"; exit 0;;',
    '  plugin) if [ "$2" = "list" ]; then echo "claude-mem@claude-mem-local (installed)"; fi; exit 0;;',
    'esac',
    'exit 0',
  ].join('\n'));
  fakeCli('opencode', `echo "opencode $*" >> "${callLog}"\necho "\${FAKE_OPENCODE_VERSION:-1.18.35}"`);
  fakeCli('dsh', `echo "dsh $*" >> "${callLog}"\nexit 0`);
}

// --- canonical inputs that already hold the user's own entries -------------------------------

const json = (value: unknown, finalNewline = true) => JSON.stringify(value, null, 2) + (finalNewline ? '\n' : '');

function seedWindsurfUserConfig(): void {
  write(join(home, '.codeium', 'windsurf', 'hooks.json'), json({
    hooks: {
      pre_user_prompt: [
        { command: './audit.sh', show_output: true },
        { command: '"/old/bun" "/old/worker-service.cjs" hook windsurf session-init', show_output: false },
      ],
      post_setup_worktree: [{ command: './setup.sh', show_output: true }],
    },
  }, false));
}

function seedKimiUserConfig(): void {
  write(join(home, '.kimi-code', 'config.toml'), 'default_model = "kimi-k2"\n\n[[hooks]]\nevent = "Stop"\ncommand = "./notify.sh"\n');
  write(join(home, '.kimi-code', 'mcp.json'), json({ mcpServers: { github: { command: 'gh-mcp' } } }));
}

function seedAntigravityUserConfig(): void {
  write(join(home, '.gemini', 'config', 'hooks.json'), json({
    'my-guard': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './guard.sh' }] }] },
    'claude-mem': { PreInvocation: [{ type: 'command', command: 'old context hook' }], Notification: [{ type: 'command', command: './keep.sh' }] },
    SessionStart: [{ matcher: '*', hooks: [{ name: 'claude-mem', type: 'command', command: 'legacy' }, { name: 'other', type: 'command', command: './other.sh' }] }],
  }));
  write(join(home, '.gemini', 'antigravity', 'mcp_config.json'), json({ mcpServers: { github: { command: 'gh-mcp' } } }));
  write(join(home, '.gemini', 'config', 'mcp_config.json'), '');
  write(join(home, '.gemini', 'GEMINI.md'), '# My rules\n\nBe terse.');
  write(join(home, '.agents', 'rules', 'claude-mem-context.md'), '# Notes\n');
}

function seedCursorUserConfig(): void {
  write(join(home, '.cursor', 'hooks.json'), json({
    version: 1,
    hooks: {
      stop: [{ command: './my-audit.sh' }, { command: '"/old/bun" "/old/worker-service.cjs" hook cursor summarize' }],
      beforeShellExecution: [{ command: './guard.sh' }],
      afterFileEdit: [{ command: './hooks/save-file-edit.sh' }],
    },
  }, false));
  write(join(home, '.cursor', 'mcp.json'), json({ mcpServers: { github: { command: 'gh-mcp' } } }, false));
}

function seedOpenCodeUserConfig(): void {
  const configDir = join(home, '.config', 'opencode');
  write(join(configDir, 'opencode.json'), json({
    $schema: 'https://opencode.ai/config.json',
    plugin: ['opencode-wakatime'],
    mcp: { github: { type: 'local', command: ['gh-mcp'] } },
  }));
  write(join(configDir, 'AGENTS.md'), '# Global rules\n\nUse tabs.\n\n<claude-mem-context>\nold memory\n</claude-mem-context>\n');
}

function seedOpenClawUserConfig(): void {
  write(join(home, '.openclaw', 'openclaw.json'), json({ theme: 'dark', plugins: { entries: { other: { enabled: true } } } }));
}

function seedCodexUserConfig(): void {
  write(join(home, '.codex', 'config.toml'), [
    'model = "o3"',
    '',
    '[features]',
    'web_search = true',
    '',
    '[mcp_servers.mcp-search]',
    'command = "node"',
    'args = ["/old/claude-mem/plugin/scripts/mcp-server.cjs"]',
    '',
    '[mcp_servers.github]',
    'command = "gh-mcp"',
    '',
  ].join('\n'));
  write(join(home, '.codex', 'AGENTS.md'), '# Codex rules\n\n<claude-mem-context>\nold\n</claude-mem-context>\n\nKeep going.\n');
}

function seedT3Code(): { settingsPath: string } {
  const settingsPath = join(home, '.t3', 'userdata', 'settings.json');
  write(settingsPath, json({
    providerInstances: {
      codex: { driver: 'codex', config: { homePath: join(home, 't3-codex-home') } },
      claude: { driver: 'claudeAgent', config: { homePath: join(home, 't3-claude-home') } },
    },
  }));
  write(join(home, 't3-codex-home', 'config.toml'), 'model = "o3"\n');
  write(join(home, 't3-claude-home', 'plugins', 'known_marketplaces.json'), json({
    other: { installLocation: '/somewhere' },
    thedotmack: { source: { source: 'github', repo: 'thedotmack/claude-mem' }, installLocation: '/old/location' },
  }));
  write(join(home, 't3-claude-home', 'settings.json'), json({ enabledPlugins: { 'claude-mem@thedotmack': true } }));
  return { settingsPath };
}

function seedGrokBotAgentData(): string {
  const agentData = join(workspace, 'agent-data');
  write(join(agentData, 'agents', 'a1', 'profile.json'), json({ name: 'Alpha Project' }));
  mkdirSync(join(agentData, 'agent-transcripts'), { recursive: true });
  return agentData;
}

function seedMcpUserConfigs(): void {
  write(join(home, '.github', 'copilot', 'mcp.json'), json({ servers: { github: { command: 'gh-mcp' } } }));
  write(join(workspace, '.roo', 'mcp.json'), json({ mcpServers: { github: { command: 'gh-mcp' } } }));
  write(join(home, '.warp', '.mcp.json'), json({ mcpServers: { github: { command: 'gh-mcp' } } }));
  write(join(workspace, 'WARP.md'), '# Warp rules\n');
  write(join(workspace, '.github', 'copilot-instructions.md'), '# Copilot rules\n\n<claude-mem-context>\nold\n</claude-mem-context>\n');
  write(join(home, '.config', 'goose', 'config.yaml'), 'GOOSE_PROVIDER: openai\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n    name: developer\n');
}

// --- the scenarios ---------------------------------------------------------------------------

type Scenario = () => Promise<number[]>;

const integrations = '../../../src/services/integrations';

async function windsurf() { return import(`${integrations}/WindsurfHooksInstaller.ts`); }
async function kimi() { return import(`${integrations}/KimiHooksInstaller.ts`); }
async function antigravity() { return import(`${integrations}/AntigravityCliHooksInstaller.ts`); }
async function cursor() { return import(`${integrations}/CursorHooksInstaller.ts`); }
async function opencode() { return import(`${integrations}/OpenCodeInstaller.ts`); }
async function openclaw() { return import(`${integrations}/OpenClawInstaller.ts`); }
async function pi() { return import(`${integrations}/PiInstaller.ts`); }
async function omp() { return import(`${integrations}/OmpHooksInstaller.ts`); }
async function t3code() { return import(`${integrations}/T3CodeInstaller.ts`); }
async function grok() { return import(`${integrations}/GrokBotInstaller.ts`); }
async function dsh() { return import(`${integrations}/DeepSeekHarnessInstaller.ts`); }
async function codex() { return import(`${integrations}/CodexCliInstaller.ts`); }
async function mcp() { return import(`${integrations}/McpIntegrations.ts`); }

function t3Spawn(_provider: unknown, args: string[]) {
  const stdout = args[0] === '--version' ? 'codex-cli 0.130.0\n' : args.join(' ') === 'plugin list' ? 'claude-mem@claude-mem-local\n' : '';
  return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null } as never;
}

const SCENARIOS: Record<string, Scenario> = {
  'windsurf-fresh': async () => [await (await windsurf()).installWindsurfHooks()],
  'windsurf-existing': async () => { seedWindsurfUserConfig(); return [await (await windsurf()).installWindsurfHooks()]; },
  'windsurf-reinstall': async () => { const m = await windsurf(); return [await m.installWindsurfHooks(), await m.installWindsurfHooks()]; },
  'windsurf-uninstall': async () => { seedWindsurfUserConfig(); const m = await windsurf(); return [await m.installWindsurfHooks(), m.uninstallWindsurfHooks()]; },

  'kimi-fresh': async () => { const m = await kimi(); return [m.installKimiHooks(), m.configureKimiMcp()]; },
  'kimi-existing': async () => { seedKimiUserConfig(); const m = await kimi(); return [m.installKimiHooks(), m.configureKimiMcp()]; },
  'kimi-reinstall': async () => { const m = await kimi(); return [m.installKimiHooks(), m.configureKimiMcp(), m.installKimiHooks(), m.configureKimiMcp()]; },
  'kimi-uninstall': async () => { seedKimiUserConfig(); const m = await kimi(); return [m.installKimiHooks(), m.configureKimiMcp(), m.uninstallKimiHooks()]; },

  'antigravity-fresh': async () => [await (await antigravity()).installAntigravityCliHooks()],
  'antigravity-existing': async () => { seedAntigravityUserConfig(); return [await (await antigravity()).installAntigravityCliHooks()]; },
  'antigravity-reinstall': async () => { const m = await antigravity(); return [await m.installAntigravityCliHooks(), await m.installAntigravityCliHooks()]; },
  'antigravity-uninstall': async () => { seedAntigravityUserConfig(); const m = await antigravity(); return [await m.installAntigravityCliHooks(), m.uninstallAntigravityCliHooks()]; },

  'cursor-fresh': async () => { const m = await cursor(); return [await m.installCursorHooks('user'), m.configureCursorMcp('user')]; },
  'cursor-existing': async () => { seedCursorUserConfig(); const m = await cursor(); return [await m.installCursorHooks('user'), m.configureCursorMcp('user')]; },
  'cursor-reinstall': async () => { const m = await cursor(); return [await m.installCursorHooks('user'), m.configureCursorMcp('user'), await m.installCursorHooks('user'), m.configureCursorMcp('user')]; },
  'cursor-project': async () => [await (await cursor()).installCursorHooks('project')],
  'cursor-uninstall': async () => { seedCursorUserConfig(); const m = await cursor(); return [await m.installCursorHooks('user'), m.uninstallCursorHooks('user')]; },

  'opencode-fresh': async () => [await (await opencode()).installOpenCodeIntegration()],
  'opencode-existing': async () => { seedOpenCodeUserConfig(); return [await (await opencode()).installOpenCodeIntegration()]; },
  'opencode-v2-existing': async () => { process.env.FAKE_OPENCODE_VERSION = 'opencode v2.0.23'; seedOpenCodeUserConfig(); return [await (await opencode()).installOpenCodeIntegration()]; },
  'opencode-uninstall': async () => { seedOpenCodeUserConfig(); const m = await opencode(); return [await m.installOpenCodeIntegration(), m.uninstallOpenCodePlugin()]; },

  'openclaw-fresh': async () => [await (await openclaw()).installOpenClawIntegration()],
  'openclaw-existing': async () => { seedOpenClawUserConfig(); return [await (await openclaw()).installOpenClawIntegration()]; },
  'openclaw-uninstall': async () => { seedOpenClawUserConfig(); const m = await openclaw(); return [await m.installOpenClawIntegration(), m.uninstallOpenClawPlugin()]; },

  'pi-fresh': async () => [(await pi()).installPiExtension()],
  'pi-uninstall': async () => { const m = await pi(); return [m.installPiExtension(), m.uninstallPiExtension()]; },

  'omp-fresh': async () => [await (await omp()).installOmpHooks()],
  'omp-uninstall': async () => { const m = await omp(); return [await m.installOmpHooks(), m.uninstallOmpHooks()]; },

  't3code-existing': async () => { const { settingsPath } = seedT3Code(); return [await (await t3code()).installT3Code(marketplace, { settingsPath, spawn: t3Spawn })]; },
  't3code-uninstall': async () => {
    const { settingsPath } = seedT3Code();
    const m = await t3code();
    return [await m.installT3Code(marketplace, { settingsPath, spawn: t3Spawn }), m.uninstallT3Code({ settingsPath })];
  },

  'grok-bot-fresh': async () => [(await grok()).installGrokBotIntegration(join(dataDir, 'transcript-watch.json'), seedGrokBotAgentData())],
  'grok-bot-existing': async () => {
    write(join(dataDir, 'transcript-watch.json'), json({ version: 1, schemas: { mine: { name: 'mine', events: [] } }, watches: [{ name: 'mine', schema: 'mine', path: '/x/*.jsonl' }, { name: 'grok-bot', schema: 'grok-bot', path: '/stale/*.jsonl' }], stateFile: '/state.json' }));
    return [(await grok()).installGrokBotIntegration(join(dataDir, 'transcript-watch.json'), seedGrokBotAgentData())];
  },

  'dsh-fresh': async () => [await (await dsh()).installDeepSeekHarness('web')],
  'dsh-uninstall': async () => { const m = await dsh(); return [await m.installDeepSeekHarness('web'), await m.uninstallDeepSeekHarness()]; },

  'codex-fresh': async () => [await (await codex()).installCodexCli(marketplace)],
  'codex-existing': async () => { seedCodexUserConfig(); return [await (await codex()).installCodexCli(marketplace)]; },
  'codex-uninstall': async () => { seedCodexUserConfig(); const m = await codex(); return [await m.installCodexCli(marketplace), m.uninstallCodexCli()]; },

  'mcp-fresh': async () => {
    mkdirSync(join(home, '.warp'), { recursive: true });
    const { MCP_IDE_INSTALLERS } = await mcp();
    return [await MCP_IDE_INSTALLERS['copilot-cli'](), await MCP_IDE_INSTALLERS['roo-code'](), await MCP_IDE_INSTALLERS.warp(), await MCP_IDE_INSTALLERS.goose()];
  },
  'mcp-existing': async () => {
    seedMcpUserConfigs();
    const { MCP_IDE_INSTALLERS } = await mcp();
    return [await MCP_IDE_INSTALLERS['copilot-cli'](), await MCP_IDE_INSTALLERS['roo-code'](), await MCP_IDE_INSTALLERS.warp(), await MCP_IDE_INSTALLERS.goose()];
  },
  'mcp-warp-missing': async () => [await (await mcp()).MCP_IDE_INSTALLERS.warp()],
  'goose-uninstall': async () => {
    seedMcpUserConfigs();
    const m = await mcp();
    return [await m.MCP_IDE_INSTALLERS.goose(), m.uninstallGooseMcpIntegration()];
  },
};

// --- snapshot ---------------------------------------------------------------------------------

/**
 * Paths the installers read but never write (the fake plugin tree, fake
 * runtimes), claude-mem's own logs and settings (its defaults change with
 * every release, whatever the installers do), and Bun's transpiler cache.
 */
const SNAPSHOT_EXCLUDES = [
  join(home, '.claude', 'plugins'),
  join(home, '.bun'),
  join(home, 'Library', 'Caches'),
  join(home, '.cache'),
  join(dataDir, 'logs'),
  join(dataDir, 'wire-gateway'),
  join(dataDir, 'settings.json'),
];
const SNAPSHOT_EXCLUDED_NAME = /^\.settings\.json\..*-migrated-v\d+$/;

function collect(directory: string, into: Record<string, string>): void {
  if (!existsSync(directory) || SNAPSHOT_EXCLUDES.includes(directory)) return;
  const entries = readdirSync(directory).sort().filter((entry) => !SNAPSHOT_EXCLUDES.includes(join(directory, entry)) && !SNAPSHOT_EXCLUDED_NAME.test(entry));
  if (entries.length === 0) into[`${relative(sandboxRoot, directory)}/`] = '<empty dir>';
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collect(path, into);
    else into[relative(sandboxRoot, path)] = readFileSync(path, 'utf-8');
  }
}

async function main(): Promise<void> {
  if (!scenarioName || !sandboxRoot || !snapshotOutPath) {
    throw new Error('usage: installer-scenarios.ts <scenario> <sandboxRoot> <snapshotOutPath>');
  }
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`unknown scenario ${scenarioName}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  seedMarketplace();
  seedFakeClis();
  const exitCodes = await scenario();
  const files: Record<string, string> = {};
  for (const directory of [home, workspace, dataDir]) collect(directory, files);
  // The agent CLIs the installers ran (Codex marketplace steps, DSH, OpenCode version probes), in order.
  const callLog = join(sandboxRoot, 'cli-calls.log');
  if (existsSync(callLog)) files['cli-calls.log'] = readFileSync(callLog, 'utf-8');
  writeFileSync(snapshotOutPath, JSON.stringify({ exitCodes, files }));
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

if (import.meta.main) {
  await main();
}
