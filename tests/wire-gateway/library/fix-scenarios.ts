// Installer scenarios for the Phase 14 review fixes, each in a sandboxed
// HOME (never the real ~/.kimi-code, ~/.codex, …): uninstall after an
// upgrade from a pre-Library install, removes with the plugin folder gone,
// the double-context guard at the installers' own call sites, and the MCP
// server's Node under npx. Started as a child by
// library-installer-fixes.test.ts, because the installers resolve their
// paths from homedir() and process.cwd() at import time:
//
//   bun fix-scenarios.ts <scenario> <sandboxRoot> <resultOutPath>
//
// <root>/home is HOME, <root>/workspace the cwd, <root>/data
// CLAUDE_MEM_DATA_DIR, <root>/bin holds fake agent CLIs.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const [scenarioName, sandboxRoot = '', resultOutPath] = process.argv.slice(2);

const home = join(sandboxRoot, 'home');
const workspace = join(sandboxRoot, 'workspace');
const dataDir = join(sandboxRoot, 'data');
const binDir = join(sandboxRoot, 'bin');
const marketplace = join(home, '.claude', 'plugins', 'marketplaces', 'thedotmack');

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** The plugin scripts the installers look for. `mcp: false` leaves out mcp-server.cjs. */
function seedPlugin(options: { mcp?: boolean } = {}): void {
  write(join(home, '.bun', 'bin', 'bun'), '', 0o755);
  write(join(marketplace, 'plugin', 'scripts', 'worker-service.cjs'), '// worker\n');
  if (options.mcp !== false) write(join(marketplace, 'plugin', 'scripts', 'mcp-server.cjs'), '// mcp\n');
  write(join(marketplace, 'openclaw', 'dist', 'index.js'), 'export default {};\n');
  write(join(marketplace, 'openclaw', 'openclaw.plugin.json'), '{"id":"claude-mem"}\n');
}

function fakeCli(name: string): void {
  write(join(binDir, name), `#!/bin/sh\necho "${name} $*" >> "${join(sandboxRoot, 'cli-calls.log')}"\nexit 0\n`, 0o755);
}

/** A wire route that injects memory for `agentId` (Phase 12): task 5 says no instruction-file block then. */
function seedInjectingRoute(agentId: string): void {
  write(join(dataDir, 'wire-gateway', 'routes.json'), JSON.stringify({
    version: 1,
    routes: { r1: { agentId, upstreamBaseUrl: 'https://example.invalid', captureSource: 'wire', features: {}, createdAt: '2026-10-23T00:00:00.000Z' } },
  }));
}

const output: string[] = [];
for (const method of ['log', 'error', 'warn'] as const) {
  console[method] = (...args: unknown[]) => output.push(args.map(String).join(' '));
}

type Scenario = () => Promise<{ exitCodes: number[]; files: Record<string, string | null> }>;

const kimiConfig = join(home, '.kimi-code', 'config.toml');
const kimiMcp = join(home, '.kimi-code', 'mcp.json');
const KIMI_OLD_BLOCK = `default_model = "k2"\n\n# >>> claude-mem kimi hooks (managed by claude-mem; do not edit) >>>\n[[hooks]]\nevent = "Stop"\ncommand = '"/old/bun" "/old/plugin/worker-service.cjs" hook kimi summarize'\ntimeout = 120\n# <<< claude-mem kimi hooks <<<\n`;
const openclawConfig = join(home, '.openclaw', 'openclaw.json');
const codexConfig = join(home, '.codex', 'config.toml');
const cursorHooks = join(home, '.cursor', 'hooks.json');
const cursorMcp = join(home, '.cursor', 'mcp.json');
const windsurfHooks = join(home, '.codeium', 'windsurf', 'hooks.json');
const agyHooks = join(home, '.gemini', 'config', 'hooks.json');
const agyMcp = join(home, '.gemini', 'antigravity', 'mcp_config.json');
const geminiMd = join(home, '.gemini', 'GEMINI.md');
const agyRules = join(home, '.agents', 'rules', 'claude-mem-context.md');

const scenarios: Record<string, Scenario> = {
  'kimi-upgrade-uninstall': async () => {
    seedPlugin();
    write(kimiConfig, KIMI_OLD_BLOCK);
    const kimi = await import('../../../src/services/integrations/KimiHooksInstaller.js');
    const exitCodes = [kimi.installKimiHooks(), kimi.configureKimiMcp(), kimi.uninstallKimiHooks()];
    return { exitCodes, files: { config: readOrNull(kimiConfig) } };
  },
  'openclaw-upgrade-uninstall': async () => {
    seedPlugin();
    write(openclawConfig, json({ gateway: { port: 1 }, plugins: { slots: { memory: 'claude-mem' }, entries: { 'claude-mem': { enabled: true, config: { workerPort: 37777, project: 'openclaw' } } } } }));
    const openclaw = await import('../../../src/services/integrations/OpenClawInstaller.js');
    const exitCodes = [openclaw.installOpenClawPlugin(), openclaw.uninstallOpenClawPlugin()];
    return { exitCodes, files: { config: readOrNull(openclawConfig), extensionIndex: readOrNull(join(home, '.openclaw', 'extensions', 'claude-mem', 'dist', 'index.js')) } };
  },
  'openclaw-uninstall-nothing-installed': async () => {
    write(openclawConfig, json({ gateway: { port: 1 } }));
    const openclaw = await import('../../../src/services/integrations/OpenClawInstaller.js');
    return { exitCodes: [openclaw.uninstallOpenClawPlugin()], files: { config: readOrNull(openclawConfig) } };
  },
  'codex-upgrade-uninstall': async () => {
    seedPlugin();
    fakeCli('codex');
    write(codexConfig, 'model = "o3"\n\n[features]\nhooks = true\n\n[plugins."claude-mem@claude-mem-local"]\nenabled = true\n\n[plugins."claude-mem@thedotmack"]\nenabled = true\n');
    const codex = await import('../../../src/services/integrations/CodexCliInstaller.js');
    codex.writeCodexPluginConfig(true);
    return { exitCodes: [codex.uninstallCodexCli()], files: { config: readOrNull(codexConfig) } };
  },
  'cursor-remove-without-plugin': async () => {
    write(cursorHooks, JSON.stringify({ version: 1, hooks: { stop: [{ command: './mine.sh' }, { command: '"/old/bun" "/old/worker-service.cjs" hook cursor summarize' }] } }, null, 2));
    write(cursorMcp, json({ mcpServers: { github: { command: 'gh' }, 'claude-mem': { command: 'node', args: ['/old/mcp-server.cjs'] } } }));
    const cursor = await import('../../../src/services/integrations/CursorHooksInstaller.js');
    return { exitCodes: [cursor.uninstallCursorHooks('user')], files: { hooks: readOrNull(cursorHooks), mcp: readOrNull(cursorMcp) } };
  },
  'kimi-remove-without-plugin': async () => {
    write(kimiConfig, KIMI_OLD_BLOCK);
    write(kimiMcp, json({ mcpServers: { github: { command: 'gh' }, 'mcp-search': { command: 'node', args: ['/old/mcp-server.cjs'] } } }));
    const kimi = await import('../../../src/services/integrations/KimiHooksInstaller.js');
    return { exitCodes: [kimi.uninstallKimiHooks()], files: { config: readOrNull(kimiConfig), mcp: readOrNull(kimiMcp) } };
  },
  'windsurf-remove-without-plugin': async () => {
    write(windsurfHooks, JSON.stringify({ hooks: { pre_user_prompt: [{ command: './audit.sh', show_output: true }, { command: '"/old/bun" "/old/worker-service.cjs" hook windsurf session-init', show_output: false }] } }, null, 2));
    const windsurf = await import('../../../src/services/integrations/WindsurfHooksInstaller.js');
    return { exitCodes: [windsurf.uninstallWindsurfHooks()], files: { hooks: readOrNull(windsurfHooks) } };
  },
  'antigravity-remove-without-plugin': async () => {
    write(agyHooks, json({ 'my-guard': { Stop: [{ type: 'command', command: './guard.sh' }] }, 'claude-mem': { Stop: [{ type: 'command', command: 'old summarize' }] } }));
    write(agyMcp, json({ mcpServers: { github: { command: 'gh' }, 'claude-mem': { command: 'node', args: ['/old/mcp-server.cjs'] } } }));
    const agy = await import('../../../src/services/integrations/AntigravityCliHooksInstaller.js');
    return { exitCodes: [agy.uninstallAntigravityCliHooks()], files: { hooks: readOrNull(agyHooks), mcp: readOrNull(agyMcp) } };
  },
  'antigravity-upgrade-uninstall': async () => {
    seedPlugin();
    write(agyHooks, json({ 'my-guard': { Stop: [{ type: 'command', command: './guard.sh' }] }, 'claude-mem': { Stop: [{ type: 'command', command: 'old summarize' }] } }));
    const agy = await import('../../../src/services/integrations/AntigravityCliHooksInstaller.js');
    const exitCodes = [await agy.installAntigravityCliHooks(), agy.uninstallAntigravityCliHooks()];
    return { exitCodes, files: { hooks: readOrNull(agyHooks) } };
  },
  'antigravity-wire-injects': async () => {
    seedPlugin();
    seedInjectingRoute('antigravity-cli');
    const agy = await import('../../../src/services/integrations/AntigravityCliHooksInstaller.js');
    return { exitCodes: [await agy.installAntigravityCliHooks()], files: { geminiMd: readOrNull(geminiMd), rules: readOrNull(agyRules), hooks: readOrNull(agyHooks) === null ? null : 'written' } };
  },
  'roo-code-wire-injects': async () => {
    seedPlugin();
    seedInjectingRoute('roo-code');
    const { MCP_IDE_INSTALLERS } = await import('../../../src/services/integrations/McpIntegrations.js');
    const exitCodes = [await MCP_IDE_INSTALLERS['roo-code']()];
    return { exitCodes, files: { rules: readOrNull(join(workspace, '.roo', 'rules', 'claude-mem-context.md')), mcp: readOrNull(join(workspace, '.roo', 'mcp.json')) } };
  },
  'copilot-mcp-node-under-npx': async () => {
    seedPlugin();
    const { MCP_IDE_INSTALLERS } = await import('../../../src/services/integrations/McpIntegrations.js');
    const exitCodes = [await MCP_IDE_INSTALLERS['copilot-cli']()];
    return { exitCodes, files: { mcp: readOrNull(join(home, '.github', 'copilot', 'mcp.json')) } };
  },
  'kimi-install-mcp-step-fails': async () => {
    seedPlugin({ mcp: false });
    const { runLibraryCli } = await import('../../../src/services/wire-gateway/library/library-cli.js');
    const exitCodes = [await runLibraryCli(['install', 'kimi'], { writeLine: (line) => output.push(line), writeError: (line) => output.push(line) })];
    return { exitCodes, files: { config: readOrNull(kimiConfig) === null ? null : 'written' } };
  },
};

const scenario = scenarios[scenarioName];
if (!scenario) throw new Error(`unknown scenario ${scenarioName}`);
const result = await scenario();
writeFileSync(resultOutPath, JSON.stringify({ ...result, output }));
process.exit(0);
