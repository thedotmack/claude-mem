import path from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

/**
 * OMP (Oh My Pi) hook installer.
 *
 * OMP auto-discovers hook modules at `<cwd>/.omp/hooks/pre/*.ts` and
 * `~/.omp/agent/hooks/pre/*.ts` (user-global via getAgentDir(); see oh-my-pi
 * builtin.ts loadHooks / getConfigDirs). Hooks are plain TypeScript modules
 * loaded in-process by OMP's Bun runtime — no build step, no manifest, no
 * shell-command wrapper (unlike Cursor/Windsurf/Antigravity, which exec the
 * worker CLI per event).
 *
 * This installer copies the shipped hook bundle to
 * `~/.omp/agent/hooks/pre/claude-mem.ts`, where OMP loads it for every session
 * regardless of project. Uninstall removes that single file.
 */

const OMP_AGENT_HOOKS_PRE_DIR = path.join(homedir(), '.omp', 'agent', 'hooks', 'pre');
const OMP_HOOK_FILENAME = 'claude-mem.ts';
const OMP_HOOK_DESTINATION = path.join(OMP_AGENT_HOOKS_PRE_DIR, OMP_HOOK_FILENAME);

/** Where the shipped hook lives: the installed marketplace root, or a repo/dev checkout. */
const OMP_HOOK_SOURCE_ROOTS = [MARKETPLACE_ROOT, process.cwd()];

export function findOmpHookSourcePath(): string | null {
  for (const root of OMP_HOOK_SOURCE_ROOTS) {
    const candidate = path.join(root, 'omp', 'hooks', OMP_HOOK_FILENAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function installOmpHooks(): Promise<number> {
  const source = findOmpHookSourcePath();
  if (!source) {
    console.error('Could not find the OMP hook bundle.');
    console.error('  Expected at: omp/hooks/claude-mem.ts');
    return 1;
  }

  try {
    mkdirSync(OMP_AGENT_HOOKS_PRE_DIR, { recursive: true });
    writeFileSync(OMP_HOOK_DESTINATION, readFileSync(source, 'utf-8'), 'utf-8');
    console.log(`  OMP hook installed to: ${OMP_HOOK_DESTINATION}`);
    logger.info('OMP', 'Hook installed', { destination: OMP_HOOK_DESTINATION });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OMP hook: ${message}`);
    return 1;
  }
}

export function uninstallOmpHooks(): number {
  if (!existsSync(OMP_HOOK_DESTINATION)) {
    console.log('  OMP hook not installed; nothing to remove.');
    return 0;
  }
  try {
    rmSync(OMP_HOOK_DESTINATION, { force: true });
    console.log(`  Removed OMP hook: ${OMP_HOOK_DESTINATION}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to remove OMP hook: ${message}`);
    return 1;
  }
}

export function checkOmpStatus(): number {
  console.log('\nClaude-Mem OMP Integration Status\n');
  console.log(`Hooks directory: ${OMP_AGENT_HOOKS_PRE_DIR}`);
  console.log(`  Exists: ${existsSync(OMP_AGENT_HOOKS_PRE_DIR) ? 'yes' : 'no'}`);
  console.log(`Hook file: ${OMP_HOOK_DESTINATION}`);
  console.log(`  Installed: ${existsSync(OMP_HOOK_DESTINATION) ? 'yes' : 'no'}`);
  console.log('');
  return 0;
}
