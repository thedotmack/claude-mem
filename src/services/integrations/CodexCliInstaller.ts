import path from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');
const MARKETPLACE_NAME = 'claude-mem-local';

function commandExists(command: string): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [command], { stdio: 'ignore' });
    } else {
      execFileSync('which', [command], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function findAncestorWithCodexPlugin(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, '.codex-plugin', 'plugin.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvePluginMarketplaceRoot(): string {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = findAncestorWithCodexPlugin(candidate);
    if (resolved) return resolved;
  }

  throw new Error('Could not locate .codex-plugin/plugin.json. Run npx claude-mem@latest install from the package or repo root.');
}

function runCodex(args: string[]): void {
  execFileSync('codex', args, {
    stdio: 'inherit',
  });
}

function removeCodexAgentsMdContext(): void {
  if (!existsSync(CODEX_AGENTS_MD_PATH)) return;

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  try {
    readAndStripContextTags(startTag, endTag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to clean AGENTS.md context', { error: message });
  }
}

function readAndStripContextTags(startTag: string, endTag: string): void {
  const content = readFileSync(CODEX_AGENTS_MD_PATH, 'utf-8');

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) return;

  const before = content.substring(0, startIdx).replace(/\n+$/, '');
  const after = content.substring(endIdx + endTag.length).replace(/^\n+/, '');
  const finalContent = (before + (after ? '\n\n' + after : '')).trim();

  if (finalContent) {
    writeFileSync(CODEX_AGENTS_MD_PATH, finalContent + '\n');
  } else {
    writeFileSync(CODEX_AGENTS_MD_PATH, '');
  }

  console.log(`  Removed legacy global context from ${CODEX_AGENTS_MD_PATH}`);
}

const cleanupLegacyCodexAgentsMdContext = removeCodexAgentsMdContext;

export async function installCodexCli(): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (native hooks)...\n');

  if (!commandExists('codex')) {
    console.error('Codex CLI was not found on PATH.');
    console.error('Install Codex, then run: npx claude-mem@latest install');
    return 1;
  }

  try {
    const marketplaceRoot = resolvePluginMarketplaceRoot();
    cleanupLegacyCodexAgentsMdContext();

    console.log(`  Registering Codex plugin marketplace: ${marketplaceRoot}`);
    runCodex(['plugin', 'marketplace', 'add', marketplaceRoot]);

    console.log(`
Installation complete!

Codex marketplace: ${MARKETPLACE_NAME}
Plugin source:     ${marketplaceRoot}

Next steps:
  1. Open Codex CLI in your project
  2. Run /plugins
  3. Install claude-mem from the claude-mem (local) marketplace

For a fresh setup, the supported entry point is:
  npx claude-mem@latest install
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallCodexCli(): number {
  console.log('\nUninstalling Claude-Mem Codex CLI integration...\n');

  try {
    if (commandExists('codex')) {
      runCodex(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    } else {
      console.log('  Codex CLI not found; skipping marketplace removal.');
    }
    cleanupLegacyCodexAgentsMdContext();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }

  console.log('\nUninstallation complete!');
  console.log('Restart Codex CLI to apply changes.\n');

  return 0;
}
