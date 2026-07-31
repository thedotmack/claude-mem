
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  getWorkerServiceAbsolutePath as findWorkerServicePath,
  getBunAbsolutePath as findBunPath,
  getMcpServerAbsolutePath,
} from './install-paths.js';
import { writeMcpJsonConfig } from './McpIntegrations.js';
import { isKimiObserverConfigured } from '../../shared/kimi-observer.js';

/**
 * Kimi Code CLI hooks installer.
 *
 * Kimi Code (Moonshot) reads hooks from `~/.kimi-code/config.toml`
 * (`$KIMI_CODE_HOME/config.toml` when the override is set) as an array of
 * `[[hooks]]` tables with exactly these fields: `event` (string), `matcher`
 * (regex, optional), `command` (string), `timeout` (int seconds, 1-600,
 * default 30). Unknown fields break config loading, so the managed block
 * below writes ONLY those fields.
 *
 * MCP servers go to `~/.kimi-code/mcp.json` in the standard
 * `{"mcpServers": {...}}` stdio shape written by writeMcpJsonConfig.
 *
 * All paths resolve lazily so tests can point KIMI_CODE_HOME at a temp dir —
 * the real ~/.kimi-code is never touched when the override is set.
 */

function kimiHomeDir(): string {
  return process.env.KIMI_CODE_HOME ?? path.join(homedir(), '.kimi-code');
}

export function kimiConfigTomlPath(): string {
  return path.join(kimiHomeDir(), 'config.toml');
}

export function kimiMcpJsonPath(): string {
  return path.join(kimiHomeDir(), 'mcp.json');
}

const MANAGED_BLOCK_START = '# >>> claude-mem kimi hooks (managed — do not edit)';
const MANAGED_BLOCK_END = '# <<< claude-mem kimi hooks';

// Hook timeout in seconds (Kimi allows 1-600, default 30). 60 matches the
// Claude Code hook default and covers a cold worker start on SessionStart —
// the `hook` CLI path ensures the worker is running before dispatching.
const HOOK_TIMEOUT_SECONDS = 60;

interface KimiHookSpec {
  event: string;
  matcher?: string;
  internalEvent: string;
}

// Kimi event → internal claude-mem event. SessionEnd is deliberately absent:
// there is no 'session-complete' handler (the worker self-completes).
const KIMI_HOOK_SPECS: KimiHookSpec[] = [
  { event: 'SessionStart', matcher: 'startup|resume', internalEvent: 'context' },
  { event: 'UserPromptSubmit', internalEvent: 'session-init' },
  { event: 'PreToolUse', matcher: 'Read', internalEvent: 'file-context' },
  { event: 'PostToolUse', internalEvent: 'observation' },
  { event: 'Stop', internalEvent: 'summarize' },
];

/**
 * Dedicated worker port for the Kimi integration. Kimi hooks (and the MCP
 * entry) bake CLAUDE_MEM_WORKER_PORT so the Kimi-facing worker runs as a
 * separate instance from the default one (37777, typically the marketplace
 * build serving Claude Code): no version-skew restarts, no PID-file fights —
 * while both share the same ~/.claude-mem database, so memory stays unified
 * across clients. NOTE: 37790 is avoided — a stale sandbox worker from June
 * sits on it with its own DB (discovered live 2026-07-28). 37791 it is.
 */
export const KIMI_WORKER_PORT = '37791';

/**
 * Env baked into every Kimi hook command. CLAUDE_MEM_CHROMA_ENABLED=false:
 * the Chroma data dir is single-writer, and the default worker (37777) already
 * owns it and backfills ALL projects from the shared DB — including
 * Kimi-written observations. Letting the Kimi instance fight for a second
 * writer just spams CHROMA_MCP errors (observed live 2026-07-29); disabling
 * Chroma on this instance keeps it FTS-only while vectorization stays
 * centralized on the default worker.
 */
const KIMI_INSTANCE_ENV: Record<string, string> = {
  CLAUDE_MEM_WORKER_PORT: KIMI_WORKER_PORT,
  CLAUDE_MEM_CHROMA_ENABLED: 'false',
};

function buildEnvPrefix(): string {
  if (process.platform === 'win32') return ''; // see buildHookCommand note
  return Object.entries(KIMI_INSTANCE_ENV)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') + ' ';
}

function buildHookCommand(bunPath: string, workerServicePath: string, internalEvent: string): string {
  const callOperator = process.platform === 'win32' ? '& ' : '';
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');
  // POSIX env prefix isolates the worker instance (see KIMI_INSTANCE_ENV). On
  // Windows cmd/PowerShell this prefix does not apply — Kimi falls back to the
  // shared default worker there (TODO: per-platform env baking if needed).
  const envPrefix = buildEnvPrefix();
  return `${callOperator}${envPrefix}"${escapedBunPath}" "${escapedWorkerPath}" hook kimi ${internalEvent}`;
}

/** TOML basic-string escaping for the command field (backslash + quote). */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildManagedHooksBlock(bunPath: string, workerServicePath: string): string {
  const lines: string[] = [MANAGED_BLOCK_START];
  for (const spec of KIMI_HOOK_SPECS) {
    lines.push('[[hooks]]');
    lines.push(`event = ${tomlBasicString(spec.event)}`);
    if (spec.matcher) {
      lines.push(`matcher = ${tomlBasicString(spec.matcher)}`);
    }
    lines.push(`command = ${tomlBasicString(buildHookCommand(bunPath, workerServicePath, spec.internalEvent))}`);
    lines.push(`timeout = ${HOOK_TIMEOUT_SECONDS}`);
    lines.push('');
  }
  lines.push(MANAGED_BLOCK_END);
  return lines.join('\n');
}

/**
 * Matches any [[hooks]] entry whose command runs our Kimi hook pipeline —
 * regardless of env prefix or script path. Used to strip orphaned entries
 * before merging: Kimi CLI rewrites config.toml through its TOML serializer
 * (observed 2026-07-28), which DROPS comments — including our managed-block
 * markers. Without this, a reinstall after such a rewrite appended a second
 * full set of kimi hooks and every injection fired twice.
 */
const KIMI_HOOK_COMMAND_PATTERN = /hook kimi \w+/;

/** Remove every [[hooks]] table whose command contains our kimi hook call. */
function stripOrphanedKimiHooks(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    // Marker comments from previous installs are dropped too — Kimi's TOML
    // serializer strips comments anyway, and leftover markers would duplicate
    // on re-install.
    if (trimmed.startsWith('#') && trimmed.includes('claude-mem kimi hooks')) {
      i++;
      continue;
    }
    if (trimmed === '[[hooks]]') {
      // Collect the whole table: header + simple `key = value` lines.
      const table: string[] = [lines[i]];
      let j = i + 1;
      while (j < lines.length && /^\s*[a-z_]+\s*=/.test(lines[j])) {
        table.push(lines[j]);
        j++;
      }
      const isOurs = table.some(line => line.trimStart().startsWith('command') && KIMI_HOOK_COMMAND_PATTERN.test(line));
      if (!isOurs) out.push(...table);
      i = j;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Idempotent merge: strips any pre-existing claude-mem kimi hook entries
 * (marked block AND orphans whose markers a serializer ate), then appends the
 * fresh managed block. User-owned `[[hooks]]` entries and every other config
 * key stay untouched.
 */
export function mergeKimiHooksToml(existingContent: string, managedBlock: string): string {
  const cleaned = stripOrphanedKimiHooks(existingContent);
  const trimmed = cleaned.trimEnd();
  return `${trimmed}${trimmed ? '\n\n' : ''}${managedBlock}\n`;
}

/** Removes every claude-mem kimi hook entry (marked block and orphans alike). */
export function removeKimiHooksToml(existingContent: string): string {
  return stripOrphanedKimiHooks(existingContent);
}

function hasManagedHooksBlock(content: string): boolean {
  return content.includes(MANAGED_BLOCK_START) && content.includes(MANAGED_BLOCK_END);
}

function registerKimiMcp(): boolean {
  const mcpServerPath = getMcpServerAbsolutePath();
  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/mcp-server.cjs');
    return false;
  }

  const mcpConfigPath = kimiMcpJsonPath();
  // Same worker-instance isolation as the hook commands (see KIMI_INSTANCE_ENV):
  // the MCP server must reach the Kimi-dedicated worker, not the default one.
  writeMcpJsonConfig(mcpConfigPath, mcpServerPath, 'mcpServers', KIMI_INSTANCE_ENV);
  console.log(`  MCP config written to: ${mcpConfigPath}`);
  return true;
}

function removeKimiMcpEntry(): boolean {
  const mcpConfigPath = kimiMcpJsonPath();
  if (!existsSync(mcpConfigPath)) return false;

  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
  } catch {
    console.log(`  Warning: could not parse ${mcpConfigPath} — leaving file intact`);
    return false;
  }

  if (!config.mcpServers || !('claude-mem' in config.mcpServers)) {
    return false;
  }

  delete config.mcpServers['claude-mem'];
  writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

export async function installKimiHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Kimi Code hooks + MCP...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  const configPath = kimiConfigTomlPath();

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    const existingContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    const managedBlock = buildManagedHooksBlock(bunPath, workerServicePath);
    const mergedContent = mergeKimiHooksToml(existingContent, managedBlock);

    if (mergedContent !== existingContent) {
      writeFileSync(configPath, mergedContent);
      console.log(`  Merged hooks into ${configPath}`);
    } else {
      console.log(`  Hooks already up to date in ${configPath}`);
    }

    console.log(`  Registered ${KIMI_HOOK_SPECS.length} hook events:`);
    for (const spec of KIMI_HOOK_SPECS) {
      console.log(`    ${spec.event}${spec.matcher ? ` (matcher: ${spec.matcher})` : ''} → ${spec.internalEvent}`);
    }

    if (!registerKimiMcp()) {
      return 1;
    }

    console.log(`
Installation complete!

Hooks installed to: ${configPath}
MCP config:         ${kimiMcpJsonPath()}
Using unified CLI:  bun worker-service.cjs hook kimi <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Kimi Code to load the hooks
  3. Memory will be captured automatically during sessions

Observer provider:
  To run the memory observer on Kimi's Anthropic-compatible endpoint
  instead of Anthropic, set ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
  and ANTHROPIC_API_KEY=<kimi key> in ~/.claude-mem/.env and
  CLAUDE_MEM_MODEL=kimi-for-coding in ~/.claude-mem/settings.json
  (see src/shared/kimi-observer.ts).
`);

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallKimiHooks(): number {
  console.log('\nUninstalling Claude-Mem Kimi Code hooks + MCP...\n');

  try {
    const configPath = kimiConfigTomlPath();
    if (existsSync(configPath)) {
      const existingContent = readFileSync(configPath, 'utf-8');
      if (hasManagedHooksBlock(existingContent)) {
        writeFileSync(configPath, removeKimiHooksToml(existingContent));
        console.log(`  Removed claude-mem hooks from ${configPath} (other config preserved)`);
      } else {
        console.log('  No claude-mem hooks found in config.toml — nothing to remove.');
      }
    } else {
      console.log('  No Kimi Code config.toml found — nothing to uninstall.');
    }

    if (removeKimiMcpEntry()) {
      console.log(`  Removed claude-mem entry from ${kimiMcpJsonPath()}`);
    }

    console.log('\nUninstallation complete!');
    console.log('Restart Kimi Code to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkKimiHooksStatus(): number {
  console.log('\nClaude-Mem Kimi Code Status\n');

  const configPath = kimiConfigTomlPath();
  if (!existsSync(configPath)) {
    console.log('Kimi Code config: Not found');
    console.log(`  Expected at: ${configPath}\n`);
    console.log('No hooks installed. Run: npx claude-mem install --ide kimi\n');
    return 0;
  }

  const content = readFileSync(configPath, 'utf-8');
  if (!hasManagedHooksBlock(content)) {
    console.log('Hooks: Not installed');
    console.log('Run: npx claude-mem install --ide kimi\n');
  } else {
    console.log(`Config: ${configPath}`);
    console.log('Mode: Unified CLI (bun worker-service.cjs hook kimi)');
    console.log(`Events: ${KIMI_HOOK_SPECS.length} mapped`);
    for (const spec of KIMI_HOOK_SPECS) {
      console.log(`  ${spec.event} → ${spec.internalEvent}`);
    }
  }

  const mcpConfigPath = kimiMcpJsonPath();
  if (!existsSync(mcpConfigPath)) {
    console.log(`MCP config (${mcpConfigPath}): Not found`);
  } else {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      const hasEntry = Boolean(config.mcpServers?.['claude-mem']);
      console.log(`MCP config (${mcpConfigPath}): ${hasEntry ? 'claude-mem registered' : 'found, but no claude-mem entry'}`);
    } catch {
      console.log(`MCP config (${mcpConfigPath}): unreadable JSON`);
    }
  }

  console.log(`Observer provider: ${isKimiObserverConfigured() ? 'Kimi endpoint (kimi-for-coding)' : 'default (Anthropic)'}`);

  console.log('');
  return 0;
}

export async function handleKimiCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installKimiHooks();

    case 'uninstall':
      return uninstallKimiHooks();

    case 'status':
      return checkKimiHooksStatus();

    default:
      console.log(`
Claude-Mem Kimi Code Integration

Usage: claude-mem kimi <command>

Commands:
  install             Install hooks into ~/.kimi-code/config.toml + MCP config
  uninstall           Remove claude-mem hooks/MCP entries (preserves other config)
  status              Check installation status

Examples:
  claude-mem kimi install     # Install hooks + MCP
  claude-mem kimi status      # Check if installed
  claude-mem kimi uninstall   # Remove hooks + MCP
      `);
      return 0;
  }
}
