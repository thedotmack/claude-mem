import path from 'path';
import { homedir } from 'os';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  cpSync,
  rmSync,
  chmodSync,
  statSync,
} from 'fs';
import { logger } from '../../utils/logger.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { DATA_DIR, USER_SETTINGS_PATH } from '../../shared/paths.js';
import {
  getBunAbsolutePath,
  getNodeAbsolutePath,
  getWorkerServiceAbsolutePath,
  getMcpServerAbsolutePath,
  getPluginRootAbsolutePath,
} from './install-paths.js';

/**
 * Kiro CLI (kiro.dev) has no standalone hooks file or plugin bundle format —
 * hooks live ONLY inside agent config JSONs (`~/.kiro/agents/*.json`, project
 * `.kiro/agents/*.json`), MCP servers in `~/.kiro/settings/mcp.json`, and
 * skills in `~/.kiro/skills/`. This installer therefore patches every agent
 * config it finds (creating a fallback agent when none exist), merges the MCP
 * entry, and copies the plugin skills verbatim (Kiro implements the same
 * Agent Skills SKILL.md standard). Everything it touches is recorded in a
 * manifest so uninstall removes exactly what was installed.
 */

interface KiroHookEntry {
  command: string;
  matcher?: string;
  timeout_ms?: number;
  cache_ttl_seconds?: number;
  [key: string]: unknown;
}

interface KiroAgentConfig {
  name?: string;
  description?: string;
  hooks?: Record<string, KiroHookEntry[]>;
  includeMcpJson?: boolean;
  [key: string]: unknown;
}

interface KiroInstallManifest {
  version: number;
  installedAt: string;
  patchedAgentFiles: string[];
  createdAgentFiles: string[];
  installedSkillDirs: string[];
  /** True when install (not the user) wrote CLAUDE_MEM_SEMANTIC_INJECT=true — uninstall reverts it. */
  enabledSemanticInject?: boolean;
}

const MANIFEST_PATH = path.join(DATA_DIR, 'kiro-install.json');

/** Read-only MCP tools safe to run without a per-call confirmation prompt. */
const MCP_AUTO_APPROVE_TOOLS = [
  'search',
  'timeline',
  'get_observations',
  'session_start_context',
  'smart_search',
  'smart_outline',
  'smart_unfold',
  'list_corpora',
  'query_corpus',
];

const FALLBACK_AGENT_DESCRIPTION = 'Agent with claude-mem persistent memory (hooks + MCP search tools)';

/**
 * True only when the agent is byte-for-byte what the installer generated
 * (minus the hooks already stripped) — a user who renamed or customised the
 * fallback agent keeps it on uninstall.
 */
function isPristineFallbackAgent(agent: KiroAgentConfig): boolean {
  return Object.keys(agent).sort().join(',') === 'description,includeMcpJson,name,tools'
    && agent.name === 'claude-mem'
    && agent.description === FALLBACK_AGENT_DESCRIPTION
    && agent.includeMcpJson === true
    && Array.isArray(agent.tools) && agent.tools.length === 1 && agent.tools[0] === '*';
}

export function getKiroHomeDir(): string {
  return process.env.KIRO_HOME ?? path.join(homedir(), '.kiro');
}

function kiroAgentsDir(): string {
  return path.join(getKiroHomeDir(), 'agents');
}

function kiroMcpJsonPath(): string {
  return path.join(getKiroHomeDir(), 'settings', 'mcp.json');
}

function kiroSkillsDir(): string {
  return path.join(getKiroHomeDir(), 'skills');
}

/**
 * Marks a hook entry as claude-mem-owned. Kiro hook entries have no `name`
 * field (unlike Gemini's), so ownership is detected by the command shape
 * buildKiroHooksBlock bakes — quoted script path + our exact argument tail —
 * which also matches stale baked paths from earlier versions without claiming
 * a user's own hand-written worker-service invocation.
 */
export function isClaudeMemHookEntry(entry: KiroHookEntry): boolean {
  if (typeof entry.command !== 'string') return false;
  return entry.command.includes('worker-service.cjs" hook kiro ')
    || entry.command.includes('worker-service.cjs" start ')
    || entry.command.includes('version-check.js" >/dev/null');
}

function quoted(p: string): string {
  return `"${p.replace(/\\/g, '\\\\')}"`;
}

/**
 * The hooks block merged into each agent config. agentSpawn stdout is injected
 * into model context, so the warm-up and version-check hooks MUST redirect
 * their output; only `hook kiro context` may print. `stop` output is parsed by
 * Kiro for a `{"decision":"block"}` override — the kiro adapter guarantees
 * empty stdout on non-context events (see src/cli/adapters/kiro.ts).
 */
export function buildKiroHooksBlock(): Record<string, KiroHookEntry[]> {
  const bun = getBunAbsolutePath();
  const node = getNodeAbsolutePath();
  const worker = getWorkerServiceAbsolutePath();
  const pluginRoot = getPluginRootAbsolutePath();
  if (!worker || !pluginRoot) {
    throw new Error(
      'Could not find plugin artifacts (worker-service.cjs). Run `npx claude-mem install` first.',
    );
  }
  const versionCheck = path.join(pluginRoot, 'scripts', 'version-check.js');

  return {
    agentSpawn: [
      {
        // Self-heals plugin node_modules (one-time bun install) and records
        // upgrade hints. Silent: agentSpawn stdout would be injected as context.
        command: `${quoted(node)} ${quoted(versionCheck)} >/dev/null 2>&1 || true`,
        timeout_ms: 300000,
      },
      {
        command: `${quoted(bun)} ${quoted(worker)} start >/dev/null 2>&1 || true`,
        timeout_ms: 60000,
      },
      {
        command: `${quoted(bun)} ${quoted(worker)} hook kiro context`,
        timeout_ms: 60000,
      },
    ],
    userPromptSubmit: [
      {
        command: `${quoted(bun)} ${quoted(worker)} hook kiro session-init`,
        timeout_ms: 60000,
      },
    ],
    postToolUse: [
      {
        matcher: '*',
        command: `${quoted(bun)} ${quoted(worker)} hook kiro observation`,
        timeout_ms: 120000,
      },
    ],
    stop: [
      {
        command: `${quoted(bun)} ${quoted(worker)} hook kiro summarize`,
        timeout_ms: 120000,
      },
    ],
  };
}

function readAgentConfig(agentPath: string): KiroAgentConfig {
  const content = readFileSync(agentPath, 'utf-8');
  try {
    return JSON.parse(content) as KiroAgentConfig;
  } catch (error) {
    logger.error('WORKER', 'Corrupt JSON in Kiro agent config', { path: agentPath }, error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Corrupt JSON in ${agentPath}, refusing to overwrite user agent config`);
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n');
  if (existsSync(filePath)) {
    // rename replaces the inode: keep the target's mode (settings.json can be
    // 0600 when it carries the server API key).
    chmodSync(tmpPath, statSync(filePath).mode & 0o7777);
  }
  renameSync(tmpPath, filePath);
}

/**
 * Replace-or-append the claude-mem hook entries in one agent config.
 * Re-running replaces existing claude-mem entries in place (handles baked-path
 * changes across upgrades) and never duplicates; user hook entries are
 * preserved untouched.
 */
export function mergeHooksIntoAgentConfig(
  agent: KiroAgentConfig,
  hooksBlock: Record<string, KiroHookEntry[]>,
): KiroAgentConfig {
  const merged = { ...agent };
  const hooks: Record<string, KiroHookEntry[]> = { ...(merged.hooks ?? {}) };

  for (const [eventName, ourEntries] of Object.entries(hooksBlock)) {
    const existing = hooks[eventName] ?? [];
    const userEntries = existing.filter(entry => !isClaudeMemHookEntry(entry));
    hooks[eventName] = [...ourEntries, ...userEntries];
  }

  merged.hooks = hooks;
  return merged;
}

function removeHooksFromAgentConfig(agent: KiroAgentConfig): { agent: KiroAgentConfig; removed: number } {
  if (!agent.hooks) {
    return { agent, removed: 0 };
  }
  let removed = 0;
  const hooks: Record<string, KiroHookEntry[]> = {};
  for (const [eventName, entries] of Object.entries(agent.hooks)) {
    const remaining = entries.filter(entry => {
      const ours = isClaudeMemHookEntry(entry);
      if (ours) removed++;
      return !ours;
    });
    if (remaining.length > 0) {
      hooks[eventName] = remaining;
    }
  }
  const next = { ...agent };
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks;
  } else {
    delete next.hooks;
  }
  return { agent: next, removed };
}

function listAgentConfigFiles(): string[] {
  const dir = kiroAgentsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(dir, name));
}

function readManifest(): KiroInstallManifest | null {
  const manifest = readJsonSafe<KiroInstallManifest | null>(MANIFEST_PATH, null);
  return manifest && Array.isArray(manifest.patchedAgentFiles) ? manifest : null;
}

function mergeMcpServerEntry(): void {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    throw new Error('Could not find mcp-server.cjs. Run `npx claude-mem install` first.');
  }
  const mcpJsonPath = kiroMcpJsonPath();
  const config = readJsonSafe<Record<string, any>>(mcpJsonPath, {});
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  config.mcpServers['claude-mem'] = {
    command: getNodeAbsolutePath(),
    args: [mcpServerPath],
    timeout: 120000,
    disabled: false,
    autoApprove: MCP_AUTO_APPROVE_TOOLS,
  };
  writeJsonAtomic(mcpJsonPath, config);
}

function removeMcpServerEntry(): boolean {
  const mcpJsonPath = kiroMcpJsonPath();
  if (!existsSync(mcpJsonPath)) return false;
  const config = readJsonSafe<Record<string, any>>(mcpJsonPath, {});
  if (!config.mcpServers || !config.mcpServers['claude-mem']) return false;
  delete config.mcpServers['claude-mem'];
  writeJsonAtomic(mcpJsonPath, config);
  return true;
}

/**
 * Kiro implements the same Agent Skills standard (SKILL.md + name/description
 * frontmatter, auto slash-command), and the plugin skills reference MCP tools
 * by bare name — so directories copy verbatim. Skill dirs that exist but are
 * not manifest-owned are left alone (user-authored name collision).
 */
function copySkills(previousManifest: KiroInstallManifest | null): string[] {
  const pluginRoot = getPluginRootAbsolutePath();
  if (!pluginRoot) return [];
  const sourceSkillsDir = path.join(pluginRoot, 'skills');
  if (!existsSync(sourceSkillsDir)) return [];

  const targetSkillsDir = kiroSkillsDir();
  mkdirSync(targetSkillsDir, { recursive: true });

  const owned = new Set(previousManifest?.installedSkillDirs ?? []);
  const installed: string[] = [];

  for (const entry of readdirSync(sourceSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(targetSkillsDir, entry.name);
    if (existsSync(target) && !owned.has(target)) {
      console.log(`  Skipping skill ${entry.name}: ${target} exists and is not claude-mem-owned`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    cpSync(path.join(sourceSkillsDir, entry.name), target, { recursive: true });
    installed.push(target);
  }
  return installed;
}

/**
 * Per-prompt semantic injection is claude-mem's compensation for two Kiro
 * gaps: preToolUse stdout is not injected (no per-file context channel) and
 * there is no post-compaction re-injection event. Default it ON for Kiro
 * installs, but never override an explicit user setting. The setting is
 * global (all platforms on this machine) — reported to the user, recorded in
 * the manifest, and reverted on uninstall.
 *
 * Returns true when the installer wrote the key.
 */
function enableSemanticInjectDefault(): boolean {
  const settings = readJsonSafe<Record<string, unknown>>(USER_SETTINGS_PATH, {});
  if (settings.CLAUDE_MEM_SEMANTIC_INJECT !== undefined) return false;
  settings.CLAUDE_MEM_SEMANTIC_INJECT = 'true';
  writeJsonAtomic(USER_SETTINGS_PATH, settings);
  console.log('  Enabled per-prompt semantic injection (CLAUDE_MEM_SEMANTIC_INJECT=true, applies to all platforms)');
  return true;
}

function revertSemanticInjectDefault(manifest: KiroInstallManifest | null): void {
  if (!manifest?.enabledSemanticInject) return;
  const settings = readJsonSafe<Record<string, unknown>>(USER_SETTINGS_PATH, {});
  // Only revert what install wrote; a user who changed the value since keeps it.
  if (settings.CLAUDE_MEM_SEMANTIC_INJECT !== 'true') return;
  delete settings.CLAUDE_MEM_SEMANTIC_INJECT;
  writeJsonAtomic(USER_SETTINGS_PATH, settings);
  console.log('  Reverted CLAUDE_MEM_SEMANTIC_INJECT to its default');
}

export async function installKiroCliIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem Kiro CLI integration...\n');

  if (process.platform === 'win32') {
    console.error('Kiro CLI is macOS/Linux only. On Windows, install claude-mem inside WSL.');
    return 1;
  }

  const kiroHome = getKiroHomeDir();
  if (!existsSync(kiroHome)) {
    console.error(`Kiro CLI not detected (no ${kiroHome}).`);
    console.error('   Install it first: https://kiro.dev/docs/cli/installation/');
    return 1;
  }

  let hooksBlock: Record<string, KiroHookEntry[]>;
  try {
    hooksBlock = buildKiroHooksBlock();
  } catch (error) {
    console.error(`\nInstallation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    // Fail on a corrupt user mcp.json BEFORE mutating any agent config — an
    // abort after agent creation would orphan artifacts the (never-written)
    // manifest can't clean up. readJsonSafe throws on a parse error.
    readJsonSafe<Record<string, unknown>>(kiroMcpJsonPath(), {});

    const previousManifest = readManifest();
    // Ownership of installer-created agents must survive the documented
    // idempotent re-run — on reinstall they show up as regular agent files.
    const previouslyCreated = new Set(previousManifest?.createdAgentFiles ?? []);
    const patchedAgentFiles: string[] = [];
    const createdAgentFiles: string[] = [];

    const agentFiles = listAgentConfigFiles();
    if (agentFiles.length === 0) {
      const fallbackPath = path.join(kiroAgentsDir(), 'claude-mem.json');
      const fallbackAgent: KiroAgentConfig = {
        name: 'claude-mem',
        description: FALLBACK_AGENT_DESCRIPTION,
        // Custom agents without a `tools` field have NO tools at all
        // (verified on kiro-cli 2.11.0) — grant everything, like the default agent.
        tools: ['*'],
        hooks: hooksBlock,
        includeMcpJson: true,
      };
      writeJsonAtomic(fallbackPath, fallbackAgent);
      createdAgentFiles.push(fallbackPath);
      console.log(`  No agent configs found — created ${fallbackPath}`);
      console.log('  Select it in Kiro with: /agent  (or add the hooks block to your own agents)');
    } else {
      for (const agentPath of agentFiles) {
        const agent = readAgentConfig(agentPath);
        const merged = mergeHooksIntoAgentConfig(agent, hooksBlock);
        writeJsonAtomic(agentPath, merged);
        (previouslyCreated.has(agentPath) ? createdAgentFiles : patchedAgentFiles).push(agentPath);
      }
      console.log(`  Merged memory hooks into ${patchedAgentFiles.length + createdAgentFiles.length} agent config(s) in ${kiroAgentsDir()}`);
    }

    mergeMcpServerEntry();
    console.log(`  Registered MCP server "claude-mem" in ${kiroMcpJsonPath()}`);

    const installedSkillDirs = copySkills(previousManifest);
    if (installedSkillDirs.length > 0) {
      console.log(`  Installed ${installedSkillDirs.length} skills to ${kiroSkillsDir()} (available as /skill-name)`);
    }

    const enabledSemanticInject =
      enableSemanticInjectDefault() || previousManifest?.enabledSemanticInject === true;

    const manifest: KiroInstallManifest = {
      version: 1,
      installedAt: new Date().toISOString(),
      patchedAgentFiles,
      createdAgentFiles,
      installedSkillDirs,
      enabledSemanticInject,
    };
    writeJsonAtomic(MANIFEST_PATH, manifest);

    console.log(`
Installation complete!

Hooks command: bun worker-service.cjs hook kiro <event>
Events: agentSpawn → context, userPromptSubmit → session-init,
        postToolUse → observation, stop → summarize

Notes:
  - New Kiro agents created later need the hooks block too — re-run
    \`npx claude-mem install --ide kiro-cli\` (idempotent) to patch them.
  - Custom agents get MCP tools when "includeMcpJson": true or "@claude-mem"
    is in their "tools" array.
  - Restart kiro-cli chat sessions to load the hooks.
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallKiroCliIntegration(): number {
  console.log('\nUninstalling Claude-Mem Kiro CLI integration...\n');

  try {
    const manifest = readManifest();

    // Strip hook entries from every agent config, not just manifest-recorded
    // ones — users may have hand-copied the block into agents created later.
    let strippedEntries = 0;
    for (const agentPath of listAgentConfigFiles()) {
      const agent = readAgentConfig(agentPath);
      const { agent: cleaned, removed } = removeHooksFromAgentConfig(agent);
      if (removed > 0) {
        strippedEntries += removed;
        const createdByUs = manifest?.createdAgentFiles.includes(agentPath) ?? false;
        if (createdByUs && isPristineFallbackAgent(cleaned)) {
          rmSync(agentPath, { force: true });
          console.log(`  Removed claude-mem-created agent ${agentPath}`);
        } else {
          writeJsonAtomic(agentPath, cleaned);
        }
      }
    }
    if (strippedEntries > 0) {
      console.log(`  Removed ${strippedEntries} hook entr${strippedEntries === 1 ? 'y' : 'ies'} from agent configs`);
    }

    if (removeMcpServerEntry()) {
      console.log(`  Removed MCP server entry from ${kiroMcpJsonPath()}`);
    }

    let removedSkills = 0;
    for (const skillDir of manifest?.installedSkillDirs ?? []) {
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true });
        removedSkills++;
      }
    }
    if (removedSkills > 0) {
      console.log(`  Removed ${removedSkills} claude-mem skills from ${kiroSkillsDir()}`);
    }

    revertSemanticInjectDefault(manifest);

    rmSync(MANIFEST_PATH, { force: true });

    console.log('\nUninstallation complete!\n');
    console.log('Restart kiro-cli to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkKiroCliStatus(): number {
  console.log('\nClaude-Mem Kiro CLI Integration Status\n');

  const kiroHome = getKiroHomeDir();
  if (!existsSync(kiroHome)) {
    console.log(`Kiro CLI: Not found (no ${kiroHome})`);
    console.log('Run: npx claude-mem install --ide kiro-cli\n');
    return 0;
  }

  const agentFiles = listAgentConfigFiles();
  const hooked: string[] = [];
  const unhooked: string[] = [];
  for (const agentPath of agentFiles) {
    try {
      const agent = readAgentConfig(agentPath);
      const hasOurs = Object.values(agent.hooks ?? {}).some(entries => entries.some(isClaudeMemHookEntry));
      (hasOurs ? hooked : unhooked).push(path.basename(agentPath));
    } catch {
      console.log(`  Warning: ${agentPath} is not valid JSON`);
    }
  }
  console.log(`Agents with memory hooks: ${hooked.length > 0 ? hooked.join(', ') : '(none)'}`);
  if (unhooked.length > 0) {
    console.log(`Agents WITHOUT memory hooks (no capture there): ${unhooked.join(', ')}`);
    console.log('  Fix: npx claude-mem install --ide kiro-cli');
  }

  const mcpConfig = readJsonSafe<Record<string, any>>(kiroMcpJsonPath(), {});
  console.log(`MCP server registered: ${mcpConfig.mcpServers?.['claude-mem'] ? 'yes' : 'no'} (${kiroMcpJsonPath()})`);

  const manifest = readManifest();
  console.log(`Skills installed: ${manifest?.installedSkillDirs.length ?? 0}`);
  console.log(`Install manifest: ${manifest ? MANIFEST_PATH : '(none)'}`);

  console.log('');
  return 0;
}

export async function handleKiroCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installKiroCliIntegration();

    case 'uninstall':
      return uninstallKiroCliIntegration();

    case 'status':
      return checkKiroCliStatus();

    default:
      console.log(`
Claude-Mem Kiro CLI Integration

Usage: claude-mem kiro-cli <command>

Commands:
  install             Patch ~/.kiro/agents/*.json with memory hooks, register MCP, copy skills
  uninstall           Remove claude-mem hooks/MCP/skills (preserves user config)
  status              Check installation status

Examples:
  claude-mem kiro-cli install     # Install integration
  claude-mem kiro-cli status      # Check if installed
  claude-mem kiro-cli uninstall   # Remove integration

For more info: https://docs.claude-mem.ai/kiro-cli/setup
      `);
      return 0;
  }
}
