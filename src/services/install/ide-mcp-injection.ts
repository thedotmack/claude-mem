// SPDX-License-Identifier: Apache-2.0
//
// multi-IDE MCP config injection for server-beta runtime.
//
// When the operator installs claude-mem with --runtime server-beta, the server
// runs in Docker. To make the in-Docker server reachable as an MCP server from
// the operator's IDEs (Claude Desktop, Claude Code, OpenCode, Codex CLI), we
// inject a `claude-mem` entry into each IDE's MCP configuration that points
// at the local mcp-server.cjs script (which itself routes to the server-beta
// HTTP API via the server-beta runtime selector).
//
// Per-IDE behaviour (idempotent):
//   - Claude Desktop:  ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
//                      Linux/Win paths also supported. Backup created on first write.
//   - Claude Code:     handled by /plugin install — this module only VERIFIES.
//   - OpenCode:        ~/.config/opencode/opencode.json — adds mcpServers entry.
//   - Codex CLI:       ~/.codex/config.toml — adds [mcp_servers.claude-mem] block.
//
// Each function returns InjectionResult so the caller can surface granular
// outcomes (skipped if IDE absent, written, already-up-to-date, failed) in the
// install summary.
//
// SAFETY: every mutator backs up the target file to <file>.pre-claude-mem-N.bak
// where N is the smallest unused integer. Rollback uses the newest backup.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { dirname, join } from 'path';

export type InjectionStatus = 'written' | 'already-current' | 'skipped' | 'failed';

export interface InjectionResult {
  ide: string;
  configPath: string;
  status: InjectionStatus;
  backupPath?: string;
  message?: string;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

/**
 * Create a backup of `targetPath` at `<targetPath>.pre-claude-mem-N.bak`
 * where N is the smallest unused integer >= 1. Idempotent: a noop if the
 * file does not exist.
 *
 * Returns the backup path (or undefined if no backup was made).
 */
export function backupFile(targetPath: string): string | undefined {
  if (!existsSync(targetPath)) return undefined;

  const dir = dirname(targetPath);
  const base = targetPath.slice(dir.length + 1);
  let n = 1;
  let backupPath = join(dir, `${base}.pre-claude-mem-${n}.bak`);
  while (existsSync(backupPath)) {
    n += 1;
    backupPath = join(dir, `${base}.pre-claude-mem-${n}.bak`);
    if (n > 999) {
      // Defence against runaway numbering — extremely unlikely.
      throw new Error(`Too many backups for ${targetPath}; clean up old .pre-claude-mem-*.bak files`);
    }
  }
  const content = readFileSync(targetPath);
  writeFileSync(backupPath, content);
  return backupPath;
}

/**
 * Find the newest pre-claude-mem backup for `targetPath`. Returns undefined if
 * none exist. Used by rollback.
 */
export function findNewestBackup(targetPath: string): string | undefined {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) return undefined;
  const base = targetPath.slice(dir.length + 1);
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.pre-claude-mem-(\\d+)\\.bak$`);
  let bestN = 0;
  let bestPath: string | undefined;
  try {
    for (const entry of readdirSync(dir)) {
      const m = entry.match(pattern);
      if (!m) continue;
      const n = Number(m[1]);
      if (n > bestN) {
        bestN = n;
        bestPath = join(dir, entry);
      }
    }
  } catch {
    return undefined;
  }
  return bestPath;
}

// ---------------------------------------------------------------------------
// JSON config helpers
// ---------------------------------------------------------------------------

/**
 * Merge a `claude-mem` MCP server entry into a JSON config file under the
 * given `serversKey` (e.g. `mcpServers` or `servers`). Backs up the existing
 * file before writing. Returns a status describing the outcome.
 */
export function injectMcpEntryIntoJsonConfig(args: {
  ide: string;
  configPath: string;
  serversKey: string;
  entry: McpServerEntry;
}): InjectionResult {
  const { ide, configPath, serversKey, entry } = args;

  try {
    const parentDir = dirname(configPath);
    mkdirSync(parentDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch (err) {
        return {
          ide,
          configPath,
          status: 'failed',
          message: `Could not parse existing config: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const serversRaw = existing[serversKey];
    const servers: Record<string, McpServerEntry> =
      serversRaw && typeof serversRaw === 'object' && !Array.isArray(serversRaw)
        ? (serversRaw as Record<string, McpServerEntry>)
        : {};

    const current = servers['claude-mem'];
    if (current && mcpEntriesEqual(current, entry)) {
      return { ide, configPath, status: 'already-current' };
    }

    const backupPath = backupFile(configPath);
    servers['claude-mem'] = entry;
    existing[serversKey] = servers;
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

    return { ide, configPath, status: 'written', backupPath };
  } catch (err) {
    return {
      ide,
      configPath,
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function mcpEntriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  if (a.command !== b.command) return false;
  if ((a.args ?? []).length !== (b.args ?? []).length) return false;
  for (let i = 0; i < (a.args ?? []).length; i++) {
    if (a.args[i] !== b.args[i]) return false;
  }
  const aEnv = a.env ?? {};
  const bEnv = b.env ?? {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (aEnv[k] !== bEnv[k]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// TOML helpers (Codex CLI)
// ---------------------------------------------------------------------------

/**
 * Parse a minimal subset of TOML — enough to detect whether
 * `[mcp_servers.claude-mem]` already exists. Returns the start/end indexes of
 * that block in the original string, or null if it does not exist.
 *
 * We do not need a full TOML parser; we just need to write/replace one block.
 */
export function findCodexBlockRange(toml: string, table: string): { start: number; end: number } | null {
  // Match a line containing only the table header (allowing trailing comments).
  const headerRegex = new RegExp(`^\\[${table.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]\\s*(#.*)?$`, 'm');
  const match = headerRegex.exec(toml);
  if (!match) return null;

  const start = match.index;
  // The block ends just before the next [...table...] header or EOF.
  let end = toml.length;
  const tail = toml.slice(start + match[0].length);
  const next = /\n\[/.exec(tail);
  if (next) {
    end = start + match[0].length + next.index + 1; // include the '\n' before next header
  }
  return { start, end };
}

/**
 * Serialize an MCP server entry as a TOML block under
 * `[mcp_servers.claude-mem]`.
 */
export function serializeCodexMcpBlock(entry: McpServerEntry): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.claude-mem]`);
  lines.push(`command = ${JSON.stringify(entry.command)}`);
  const argsLiteral = entry.args.map((a) => JSON.stringify(a)).join(', ');
  lines.push(`args = [${argsLiteral}]`);
  if (entry.env && Object.keys(entry.env).length > 0) {
    const envInline = Object.entries(entry.env)
      .map(([k, v]) => `${tomlBareKey(k)} = ${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`env = { ${envInline} }`);
  }
  return lines.join('\n') + '\n';
}

function tomlBareKey(key: string): string {
  // Bare keys must match [A-Za-z0-9_-]+; otherwise quote.
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Inject (or replace) a `[mcp_servers.claude-mem]` block in a Codex CLI
 * config.toml file.
 */
export function injectCodexMcpBlock(args: {
  configPath: string;
  entry: McpServerEntry;
}): InjectionResult {
  const { configPath, entry } = args;
  const ide = 'codex-cli';
  try {
    const parentDir = dirname(configPath);
    mkdirSync(parentDir, { recursive: true });

    let existing = '';
    if (existsSync(configPath)) {
      existing = readFileSync(configPath, 'utf-8');
    }

    const newBlock = serializeCodexMcpBlock(entry);

    const range = findCodexBlockRange(existing, 'mcp_servers.claude-mem');
    if (range) {
      const currentBlock = existing.slice(range.start, range.end);
      if (currentBlock.trim() === newBlock.trim()) {
        return { ide, configPath, status: 'already-current' };
      }
      const backupPath = backupFile(configPath);
      const before = existing.slice(0, range.start).replace(/\n+$/, '');
      const after = existing.slice(range.end).replace(/^\n+/, '');
      const merged =
        (before ? before + '\n\n' : '') +
        newBlock +
        (after ? '\n' + after : '');
      writeFileSync(configPath, merged, 'utf-8');
      return { ide, configPath, status: 'written', backupPath };
    }

    const backupPath = backupFile(configPath);
    const merged = (existing.trim() ? existing.trimEnd() + '\n\n' : '') + newBlock;
    writeFileSync(configPath, merged, 'utf-8');
    return { ide, configPath, status: 'written', backupPath };
  } catch (err) {
    return {
      ide,
      configPath,
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Per-IDE config path resolution
// ---------------------------------------------------------------------------

export function claudeDesktopConfigPath(): string {
  const home = homedir();
  const p = platform();
  if (p === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  // Linux + others — Claude Desktop is not officially supported on Linux yet,
  // but follow the documented config path for forward-compat.
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

export function openCodeConfigPath(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json');
  }
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

export function codexCliConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

/**
 * Returns true when the marketplace plugin file is already registered.
 * For Claude Code, the /plugin install path handles registration; this is
 * just a verifier we call at the end of setup.
 */
export function claudeCodePluginInstalled(marketplaceDir: string): boolean {
  return existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));
}

// ---------------------------------------------------------------------------
// Detection — match the existing ide-detection.ts policy. We only inject when
// either the config dir exists OR the CLI is on PATH (when applicable).
// ---------------------------------------------------------------------------

export function detectClaudeDesktop(): boolean {
  // Presence of any of the per-platform config dirs counts as "installed"
  // because Claude Desktop creates the dir on first run.
  return existsSync(dirname(claudeDesktopConfigPath()));
}

export function detectOpenCode(): boolean {
  return existsSync(join(homedir(), '.config', 'opencode')) || isCommandOnPath('opencode');
}

export function detectCodexCli(): boolean {
  return existsSync(join(homedir(), '.codex')) || isCommandOnPath('codex');
}

function isCommandOnPath(cmd: string): boolean {
  try {
    const PATH = process.env.PATH ?? '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of PATH.split(sep)) {
      if (!dir) continue;
      for (const ext of exts) {
        if (existsSync(join(dir, cmd + ext))) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aggregate entry point — used by setupServerBeta()
// ---------------------------------------------------------------------------

export interface InjectAllOptions {
  /** Path to plugin/scripts/mcp-server.cjs */
  mcpServerPath: string;
  /** Path to ~/.claude/plugins/marketplaces/thedotmack for Claude Code verify. */
  marketplaceDir: string;
  /**
   * Comma-separated list of IDE ids the operator explicitly opted into. When
   * empty, we auto-detect; when set, missing IDEs from this list are errors,
   * not skips.
   */
  optInIdes?: string[];
  /** Env vars to pass through to the MCP server child process. */
  childEnv?: Record<string, string>;
}

export function buildMcpEntry(mcpServerPath: string, childEnv?: Record<string, string>): McpServerEntry {
  return {
    command: process.execPath,
    args: [mcpServerPath],
    ...(childEnv && Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
  };
}

// OpenCode uses a different MCP config schema than Claude Desktop:
//   - Top-level key is 'mcp', not 'mcpServers'
//   - Each entry has shape { type: 'local', command: [exec, ...args], enabled: true }
//     instead of { command: exec, args: [...] }
//   - Env vars live under 'environment', not 'env'
// See https://opencode.ai/docs/mcp-servers/
// Mixing these formats silently produces an opencode.json that OpenCode
// rejects on load with "Unrecognized key: mcpServers".
interface OpenCodeMcpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
  environment?: Record<string, string>;
}

function buildOpenCodeMcpEntry(
  mcpServerPath: string,
  childEnv?: Record<string, string>,
): OpenCodeMcpEntry {
  return {
    type: 'local',
    command: [process.execPath, mcpServerPath],
    enabled: true,
    ...(childEnv && Object.keys(childEnv).length > 0 ? { environment: childEnv } : {}),
  };
}

function openCodeEntriesEqual(a: OpenCodeMcpEntry, b: OpenCodeMcpEntry): boolean {
  if (a.type !== b.type) return false;
  if (a.enabled !== b.enabled) return false;
  if (a.command.length !== b.command.length) return false;
  for (let i = 0; i < a.command.length; i++) {
    if (a.command[i] !== b.command[i]) return false;
  }
  const aEnv = a.environment ?? {};
  const bEnv = b.environment ?? {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (aEnv[k] !== bEnv[k]) return false;
  }
  return true;
}

export function injectOpenCodeMcpEntry(args: {
  configPath: string;
  entry: OpenCodeMcpEntry;
}): InjectionResult {
  const ide = 'opencode';
  const { configPath, entry } = args;
  try {
    const parentDir = dirname(configPath);
    mkdirSync(parentDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch (err) {
        return {
          ide,
          configPath,
          status: 'failed',
          message: `Could not parse existing config: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // OpenCode's loader requires `$schema` on every config file. Adding it
    // here means a fresh-install config is immediately valid; never overwrite
    // when already present.
    if (typeof existing.$schema !== 'string' || existing.$schema.length === 0) {
      existing.$schema = 'https://opencode.ai/config.json';
    }

    const mcpRaw = existing.mcp;
    const mcp: Record<string, OpenCodeMcpEntry> =
      mcpRaw && typeof mcpRaw === 'object' && !Array.isArray(mcpRaw)
        ? (mcpRaw as Record<string, OpenCodeMcpEntry>)
        : {};

    const current = mcp['claude-mem'];
    // Idempotency: identical entry already present → no write, no new backup.
    // Without this every re-install accumulated a .pre-claude-mem-N.bak even
    // when nothing changed (operators were seeing 7+ backup files).
    if (current && openCodeEntriesEqual(current, entry)) {
      return { ide, configPath, status: 'already-current' };
    }

    // Self-heal: if the file currently has the wrong-key `mcpServers` from a
    // pre-fix install, strip it out so OpenCode stops rejecting the whole
    // config. The plugin file at ~/.config/opencode/plugins/claude-mem.js
    // carries our actual capture path; dropping a stale mcpServers entry
    // never loses functional state.
    if ('mcpServers' in existing) {
      delete (existing as Record<string, unknown>).mcpServers;
    }

    const backupPath = backupFile(configPath);
    mcp['claude-mem'] = entry;
    existing.mcp = mcp;
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    return { ide, configPath, status: 'written', backupPath };
  } catch (err) {
    return {
      ide,
      configPath,
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function rollbackOpenCodeMcpEntry(configPath: string): RollbackResult {
  const ide = 'opencode';
  try {
    if (!existsSync(configPath)) {
      return { ide, configPath, action: 'absent' };
    }
    const backup = findNewestBackup(configPath);
    if (backup) {
      const contents = readFileSync(backup);
      writeFileSync(configPath, contents);
      return { ide, configPath, action: 'restored', backupRestored: backup };
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    let removed = false;
    // Drop claude-mem from `mcp` (the canonical OpenCode key).
    const mcp = parsed.mcp;
    if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
      const map = mcp as Record<string, unknown>;
      if ('claude-mem' in map) {
        delete map['claude-mem'];
        parsed.mcp = map;
        removed = true;
      }
    }
    // Also clean up the broken `mcpServers` key if a pre-fix install left
    // one behind. Mirrors the self-heal in the inject path.
    const broken = parsed.mcpServers;
    if (broken && typeof broken === 'object' && !Array.isArray(broken)) {
      const map = broken as Record<string, unknown>;
      if ('claude-mem' in map) {
        delete map['claude-mem'];
        parsed.mcpServers = map;
        removed = true;
      }
      if (Object.keys(map).length === 0) {
        delete (parsed as Record<string, unknown>).mcpServers;
        removed = true;
      }
    }
    if (removed) {
      writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      return { ide, configPath, action: 'removed-entry' };
    }
    return { ide, configPath, action: 'no-backup', message: 'No backup found and no claude-mem entry to remove' };
  } catch (err) {
    return {
      ide,
      configPath,
      action: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function injectAllIdes(options: InjectAllOptions): InjectionResult[] {
  const entry = buildMcpEntry(options.mcpServerPath, options.childEnv);
  const optIn = new Set(options.optInIdes ?? []);
  const results: InjectionResult[] = [];

  // --- Claude Desktop ---
  {
    const detected = detectClaudeDesktop();
    const required = optIn.has('claude-desktop');
    if (!detected && !required) {
      results.push({ ide: 'claude-desktop', configPath: claudeDesktopConfigPath(), status: 'skipped', message: 'Claude Desktop config dir not found' });
    } else {
      results.push(injectMcpEntryIntoJsonConfig({
        ide: 'claude-desktop',
        configPath: claudeDesktopConfigPath(),
        serversKey: 'mcpServers',
        entry,
      }));
    }
  }

  // --- Claude Code (verify only) ---
  {
    const installed = claudeCodePluginInstalled(options.marketplaceDir);
    results.push({
      ide: 'claude-code',
      configPath: join(options.marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'),
      status: installed ? 'already-current' : 'skipped',
      message: installed
        ? 'Claude Code plugin already registered by /plugin install'
        : 'Marketplace plugin.json missing — Claude Code plugin not installed',
    });
  }

  // --- OpenCode ---
  {
    const detected = detectOpenCode();
    const required = optIn.has('opencode');
    if (!detected && !required) {
      results.push({ ide: 'opencode', configPath: openCodeConfigPath(), status: 'skipped', message: 'OpenCode not detected' });
    } else {
      results.push(injectOpenCodeMcpEntry({
        configPath: openCodeConfigPath(),
        entry: buildOpenCodeMcpEntry(options.mcpServerPath, options.childEnv),
      }));
      // fix — OpenCode supports plugins via its own API (not MCP).
      // Copy our claude-mem plugin into ~/.config/opencode/plugins/ so
      // session.created, tool.execute.before/after, message.updated, and
      // session.idle events get auto-captured into the same memory store.
      // Symmetric to the Claude Code plugin/hooks/hooks.json wiring.
      installOpenCodePlugin(options.marketplaceDir);
    }
  }

  // --- Codex CLI ---
  {
    const detected = detectCodexCli();
    const required = optIn.has('codex-cli');
    if (!detected && !required) {
      results.push({ ide: 'codex-cli', configPath: codexCliConfigPath(), status: 'skipped', message: 'Codex CLI not detected' });
    } else {
      results.push(injectCodexMcpBlock({
        configPath: codexCliConfigPath(),
        entry,
      }));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Rollback — restore newest backup or remove the claude-mem entry.
// ---------------------------------------------------------------------------

export interface RollbackResult {
  ide: string;
  configPath: string;
  action: 'restored' | 'removed-entry' | 'no-backup' | 'absent' | 'failed';
  backupRestored?: string;
  message?: string;
}

export function rollbackJsonConfig(args: {
  ide: string;
  configPath: string;
  serversKey: string;
}): RollbackResult {
  const { ide, configPath, serversKey } = args;
  try {
    if (!existsSync(configPath)) {
      return { ide, configPath, action: 'absent' };
    }
    const backup = findNewestBackup(configPath);
    if (backup) {
      const contents = readFileSync(backup);
      writeFileSync(configPath, contents);
      return { ide, configPath, action: 'restored', backupRestored: backup };
    }
    // No backup — fall back to removing only the claude-mem entry so we
    // don't clobber user-added MCP servers.
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const servers = parsed[serversKey];
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      const map = servers as Record<string, unknown>;
      if ('claude-mem' in map) {
        delete map['claude-mem'];
        parsed[serversKey] = map;
        writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
        return { ide, configPath, action: 'removed-entry' };
      }
    }
    return { ide, configPath, action: 'no-backup', message: 'No backup found and no claude-mem entry to remove' };
  } catch (err) {
    return {
      ide,
      configPath,
      action: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function rollbackCodexConfig(configPath: string): RollbackResult {
  const ide = 'codex-cli';
  try {
    if (!existsSync(configPath)) {
      return { ide, configPath, action: 'absent' };
    }
    const backup = findNewestBackup(configPath);
    if (backup) {
      const contents = readFileSync(backup);
      writeFileSync(configPath, contents);
      return { ide, configPath, action: 'restored', backupRestored: backup };
    }
    const existing = readFileSync(configPath, 'utf-8');
    const range = findCodexBlockRange(existing, 'mcp_servers.claude-mem');
    if (range) {
      const before = existing.slice(0, range.start).replace(/\n+$/, '');
      const after = existing.slice(range.end).replace(/^\n+/, '');
      const merged = before + (after ? '\n\n' + after : '\n');
      writeFileSync(configPath, merged.trimEnd() + '\n', 'utf-8');
      return { ide, configPath, action: 'removed-entry' };
    }
    return { ide, configPath, action: 'no-backup', message: 'No backup found and no [mcp_servers.claude-mem] block to remove' };
  } catch (err) {
    return {
      ide,
      configPath,
      action: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function rollbackAllIdes(): RollbackResult[] {
  // also remove the OpenCode plugin file when uninstalling so
  // the next OpenCode session doesn't try to POST to a dead server. Result
  // is folded into the OpenCode rollback row so the uninstall UI stays tidy.
  const opencodePluginRemoved = rollbackOpenCodePlugin();
  const opencodeMcp = rollbackOpenCodeMcpEntry(openCodeConfigPath());
  if (opencodePluginRemoved.removed) {
    opencodeMcp.message = `${opencodeMcp.message ?? ''} (also removed plugin at ${opencodePluginRemoved.path})`.trim();
  }
  return [
    rollbackJsonConfig({ ide: 'claude-desktop', configPath: claudeDesktopConfigPath(), serversKey: 'mcpServers' }),
    opencodeMcp,
    rollbackCodexConfig(codexCliConfigPath()),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode plugin installer.
//
// OpenCode discovers plugins under ~/.config/opencode/plugins/. We ship a
// single JavaScript file (plugin/opencode/claude-mem-plugin.js) that wires
// up the OpenCode event hooks and POSTs them to the claude-mem server.
// At install time we copy that file into the global plugins dir. On uninstall
// we delete it via rollbackOpenCodePlugin().
// ─────────────────────────────────────────────────────────────────────────────

const OPENCODE_PLUGIN_FILENAME = 'claude-mem-plugin.js';

function openCodePluginsDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return join(process.env.OPENCODE_CONFIG_DIR, 'plugins');
  }
  return join(homedir(), '.config', 'opencode', 'plugins');
}

function openCodePluginInstallPath(): string {
  return join(openCodePluginsDir(), OPENCODE_PLUGIN_FILENAME);
}

export function installOpenCodePlugin(marketplaceDir: string): void {
  try {
    const source = join(marketplaceDir, 'plugin', 'opencode', OPENCODE_PLUGIN_FILENAME);
    if (!existsSync(source)) {
      // Plugin source missing — non-fatal; install proceeds without OpenCode
      // hook capture. The IDE still has the MCP entry for manual search.
      return;
    }
    const targetDir = openCodePluginsDir();
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    const target = openCodePluginInstallPath();
    copyFileSync(source, target);
  } catch {
    // Best effort — never block install on OpenCode plugin install failure.
  }
}

export function rollbackOpenCodePlugin(): { path: string; removed: boolean } {
  const target = openCodePluginInstallPath();
  if (!existsSync(target)) return { path: target, removed: false };
  try {
    unlinkSync(target);
    return { path: target, removed: true };
  } catch {
    return { path: target, removed: false };
  }
}
