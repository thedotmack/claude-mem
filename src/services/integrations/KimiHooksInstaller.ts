/**
 * KimiHooksInstaller.ts — first-class Kimi Code CLI harness integration.
 *
 * Kimi hooks live in `[[hooks]]` tables inside $KIMI_CODE_HOME/config.toml
 * (TOML). Following the CodexCliInstaller precedent we merge text-level,
 * inside a marker-delimited managed block — no TOML library. The MCP server
 * registration goes into $KIMI_CODE_HOME/mcp.json (plain JSON merge).
 * Absolute paths are baked per Rule B (install-paths.ts): Kimi performs no
 * variable substitution on hook commands.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { kimiCodeHome, kimiConfigPath, kimiMcpJsonPath } from '../../shared/kimi-paths.js';
import {
  getBunAbsolutePath,
  getMcpServerAbsolutePath,
  getNodeAbsolutePath,
  getWorkerServiceAbsolutePath,
} from './install-paths.js';

export const KIMI_MARKER_BEGIN = '# >>> claude-mem kimi hooks (managed by claude-mem; do not edit) >>>';
export const KIMI_MARKER_END = '# <<< claude-mem kimi hooks <<<';

/** Six rules, full parity with the Claude Code hook surface. */
export function buildKimiHooksBlock(bunPath: string, workerPath: string): string {
  const run = (suffix: string) => `'"${bunPath}" "${workerPath}" ${suffix}'`;
  const rules = [
    { event: 'SessionStart', matcher: 'startup|resume', command: run('start'), timeout: 120 },
    { event: 'UserPromptSubmit', matcher: undefined, command: run('hook kimi session-init-context'), timeout: 120 },
    { event: 'PostToolUse', matcher: undefined, command: run('hook kimi observation'), timeout: 120 },
    { event: 'PreToolUse', matcher: 'Read', command: run('hook kimi file-context'), timeout: 60 },
    { event: 'Stop', matcher: undefined, command: run('hook kimi summarize'), timeout: 120 },
    { event: 'PreCompact', matcher: 'manual|auto', command: run('hook kimi summarize'), timeout: 120 },
  ];
  const body = rules
    .map((rule) => {
      const lines = ['[[hooks]]', `event = "${rule.event}"`];
      if (rule.matcher) lines.push(`matcher = "${rule.matcher}"`);
      lines.push(`command = ${rule.command}`, `timeout = ${rule.timeout}`);
      return lines.join('\n');
    })
    .join('\n\n');
  return `${KIMI_MARKER_BEGIN}\n${body}\n${KIMI_MARKER_END}`;
}

export function upsertManagedBlock(content: string, block: string): string {
  const begin = content.indexOf(KIMI_MARKER_BEGIN);
  const end = content.indexOf(KIMI_MARKER_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return content.slice(0, begin) + block + content.slice(end + KIMI_MARKER_END.length);
  }
  const separator = content.length === 0 || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return content + separator + block + '\n';
}

export function removeManagedBlock(content: string): string {
  const begin = content.indexOf(KIMI_MARKER_BEGIN);
  const end = content.indexOf(KIMI_MARKER_END);
  if (begin === -1 || end === -1 || end <= begin) return content;
  const prefix = content.slice(0, begin).replace(/\n+$/, '');
  const suffix = content.slice(end + KIMI_MARKER_END.length).replace(/^\n+/, '');
  if (prefix.length === 0) return suffix;
  if (suffix.length === 0) return `${prefix}\n`;
  return `${prefix}\n\n${suffix}`;
}

function backupOnce(configPath: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backupPath = `${configPath}.bak-${stamp}`;
  if (existsSync(configPath) && !existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(configPath, 'utf-8'));
  }
}

export function installKimiHooks(): number {
  const workerPath = getWorkerServiceAbsolutePath();
  if (!workerPath) {
    console.error('Could not find worker-service.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const bunPath = getBunAbsolutePath();
  const configPath = kimiConfigPath();
  try {
    mkdirSync(kimiCodeHome(), { recursive: true });
    backupOnce(configPath);
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    writeFileSync(configPath, upsertManagedBlock(current, buildKimiHooksBlock(bunPath, workerPath)));
    console.log(`  Installed Kimi hooks into ${configPath}`);
    console.log(`    Bun runtime: ${bunPath}`);
    console.log(`    Worker: ${workerPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to install Kimi hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function configureKimiMcp(): number {
  const serverPath = getMcpServerAbsolutePath();
  if (!serverPath) {
    console.error('Could not find mcp-server.cjs (expected under the installed plugin scripts/ directory)');
    return 1;
  }
  const mcpPath = kimiMcpJsonPath();
  try {
    mkdirSync(kimiCodeHome(), { recursive: true });
    const config: { mcpServers?: Record<string, unknown> } = existsSync(mcpPath)
      ? JSON.parse(readFileSync(mcpPath, 'utf-8'))
      : {};
    config.mcpServers ??= {};
    if (config.mcpServers['mcp-search']) {
      console.log('  MCP server mcp-search already configured in mcp.json');
      return 0;
    }
    config.mcpServers['mcp-search'] = {
      type: 'stdio',
      command: getNodeAbsolutePath(),
      args: [serverPath],
    };
    writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`  Configured MCP server in ${mcpPath}`);
    return 0;
  } catch (error) {
    console.error(`Failed to configure Kimi MCP: ${(error as Error).message}`);
    return 1;
  }
}

export function uninstallKimiHooks(): number {
  const configPath = kimiConfigPath();
  if (!existsSync(configPath)) {
    console.log('  No Kimi config.toml found; nothing to uninstall');
    return 0;
  }
  try {
    const current = readFileSync(configPath, 'utf-8');
    const next = removeManagedBlock(current);
    if (next !== current) {
      writeFileSync(configPath, next);
      console.log('  Removed claude-mem hooks from config.toml');
    } else {
      console.log('  No claude-mem hook block found in config.toml');
    }
    return 0;
  } catch (error) {
    console.error(`Failed to uninstall Kimi hooks: ${(error as Error).message}`);
    return 1;
  }
}

export function checkKimiHooksStatus(): number {
  const configPath = kimiConfigPath();
  const installed = existsSync(configPath) && readFileSync(configPath, 'utf-8').includes(KIMI_MARKER_BEGIN);
  if (installed) {
    console.log(`  Kimi hooks: installed (${configPath})`);
    return 0;
  }
  console.log('  Kimi hooks: not installed');
  return 1;
}

export async function handleKimiCommand(subcommand: string | undefined, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const hooks = installKimiHooks();
      const mcp = configureKimiMcp();
      return hooks === 0 && mcp === 0 ? 0 : 1;
    }
    case 'uninstall':
      return uninstallKimiHooks();
    case 'status':
      return checkKimiHooksStatus();
    default:
      console.log('Usage: claude-mem kimi <install|uninstall|status>');
      return subcommand === undefined || subcommand === 'help' ? 0 : 1;
  }
}
