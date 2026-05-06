import path from 'path';
import { homedir } from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');
const MARKETPLACE_NAME = 'claude-mem-local';
const MIN_CODEX_MARKETPLACE_VERSION = '0.128.0';
const REQUIRED_MARKETPLACE_FILES = [
  path.join('.agents', 'plugins', 'marketplace.json'),
  path.join('.codex-plugin', 'plugin.json'),
  '.mcp.json',
];

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

function missingMarketplaceFiles(root: string): string[] {
  return REQUIRED_MARKETPLACE_FILES.filter((entry) => !existsSync(path.join(root, entry)));
}

function assertCodexMarketplaceRoot(root: string): string {
  const resolved = path.resolve(root);
  const missing = missingMarketplaceFiles(resolved);
  if (missing.length > 0) {
    throw new Error(`Codex marketplace root ${resolved} is missing required files: ${missing.join(', ')}`);
  }
  return resolved;
}

function resolvePluginMarketplaceRoot(preferredRoot?: string): string {
  if (preferredRoot) {
    return assertCodexMarketplaceRoot(preferredRoot);
  }

  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const resolved = findAncestorWithCodexPlugin(candidate);
    if (resolved && missingMarketplaceFiles(resolved).length === 0) return resolved;
  }

  throw new Error('Could not locate a Codex marketplace root with .agents/plugins/marketplace.json, .codex-plugin/plugin.json, and .mcp.json. Run npx claude-mem@latest install from the package or repo root.');
}

function runCodex(args: string[]): void {
  const result = spawnSync('codex', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = console;
  const stdout = result.stdout?.trimEnd();
  const stderr = result.stderr?.trimEnd();

  if (stdout) output.log(stdout);
  if (stderr) output.error(stderr);

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const exitCode = result.status ?? 'unknown';
    throw new Error(`codex ${args.join(' ')} failed with exit code ${exitCode}${stderr ? `: ${stderr}` : ''}`);
  }
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}

function assertCodexMarketplaceSupported(): void {
  const result = spawnSync('codex', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.warn(`  Could not determine Codex CLI version. Continuing; plugin marketplace support requires ${MIN_CODEX_MARKETPLACE_VERSION} or newer.${output ? `\n${output}` : ''}`);
    return;
  }

  const version = parseSemver(output);
  if (!version) {
    console.warn(`  Could not parse Codex CLI version from "${output || '<empty>'}". Continuing; plugin marketplace support requires ${MIN_CODEX_MARKETPLACE_VERSION} or newer.`);
    return;
  }

  const minimumVersion = parseSemver(MIN_CODEX_MARKETPLACE_VERSION);
  if (minimumVersion && compareSemver(version, minimumVersion) < 0) {
    throw new Error(`Codex CLI ${version.join('.')} is too old for plugin marketplace support. Update Codex CLI to ${MIN_CODEX_MARKETPLACE_VERSION} or newer, then run: npx claude-mem@latest install`);
  }
}

function removeCodexAgentsMdContext(): boolean {
  if (!existsSync(CODEX_AGENTS_MD_PATH)) return true;

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  try {
    readAndStripContextTags(startTag, endTag);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to clean AGENTS.md context', { error: message });
    return false;
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

export async function installCodexCli(marketplaceRootOverride?: string): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (native hooks)...\n');

  if (!commandExists('codex')) {
    console.error('Codex CLI was not found on PATH.');
    console.error('Install Codex, then run: npx claude-mem@latest install');
    return 1;
  }

  try {
    assertCodexMarketplaceSupported();
    const marketplaceRoot = resolvePluginMarketplaceRoot(marketplaceRootOverride);

    console.log(`  Registering Codex plugin marketplace: ${marketplaceRoot}`);
    runCodex(['plugin', 'marketplace', 'add', marketplaceRoot]);
    if (!cleanupLegacyCodexAgentsMdContext()) {
      console.warn(`  Native Codex hooks registered, but failed to remove legacy AGENTS.md context from ${CODEX_AGENTS_MD_PATH}.`);
    }

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

  let failed = false;

  try {
    if (commandExists('codex')) {
      runCodex(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    } else {
      console.log('  Codex CLI not found; skipping marketplace removal.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nCodex marketplace removal failed: ${message}`);
    failed = true;
  }

  try {
    if (!cleanupLegacyCodexAgentsMdContext()) {
      console.error(`\nFailed to remove legacy AGENTS.md context from ${CODEX_AGENTS_MD_PATH}.`);
      failed = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nLegacy AGENTS.md cleanup failed: ${message}`);
    failed = true;
  }

  if (failed) {
    console.error('\nUninstallation completed with errors.');
    return 1;
  }

  console.log('\nUninstallation complete!');
  console.log('Restart Codex CLI to apply changes.\n');

  return 0;
}
