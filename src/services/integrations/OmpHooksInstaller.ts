import path from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { writeTextFileAtomic } from '../../shared/atomic-json.js';
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

const OMP_HOOK_FILENAME = 'claude-mem.ts';

function ompProfile(value: string | undefined): string | undefined {
  const profile = value?.trim();
  if (!profile || profile === 'default') return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) || profile.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(profile)) {
    throw new Error(`Invalid OMP profile: ${value}`);
  }
  return profile;
}

/** Match OMP's getAgentDir() selection (oh-my-pi v18.18.8, utils/src/dirs.ts).
 * Named profiles own their agent directory even with an explicit agent override.
 * XDG moves OMP data, not its hook/config directory. Resolve per invocation. */
function ompHooksPreDir(): string {
  const configRoot = path.join(homedir(), process.env.PI_CONFIG_DIR || '.omp');
  const profile = ompProfile(process.env.OMP_PROFILE ?? process.env.PI_PROFILE);
  let agentDir: string;
  if (profile) {
    agentDir = path.join(configRoot, 'profiles', profile, 'agent');
  } else {
    let override = process.env.PI_CODING_AGENT_DIR;
    // OMP propagates a profile-derived agent path to child processes. When
    // OMP_PROFILE explicitly resets the legacy PI_PROFILE to default, that
    // inherited path is not a custom default-profile override.
    let legacyProfile: string | undefined;
    try { legacyProfile = ompProfile(process.env.PI_PROFILE); } catch { /* inactive legacy value */ }
    if (legacyProfile && override === path.join(configRoot, 'profiles', legacyProfile, 'agent')) {
      override = undefined;
    }
    agentDir = override ? path.resolve(override) : path.join(configRoot, 'agent');
  }
  return path.join(agentDir, 'hooks', 'pre');
}

function ompHookDestination(): string {
  return path.join(ompHooksPreDir(), OMP_HOOK_FILENAME);
}

/** Trusted locations for the shipped hook. The marketplace root is the
 *  canonical, claude-mem-installed source. A repo/checkout source is honored
 *  only behind an explicit dev opt-in — never by default: process.cwd() could
 *  be an untrusted repository whose omp/hooks/ would then be installed as a
 *  persistent user-global OMP hook (~/.omp/agent/hooks/pre/). (Greptile P1.) */
export function findOmpHookSourcePath(): string | null {
  const roots = [MARKETPLACE_ROOT];
  if (process.env.CLAUDE_MEM_DEV_HOOK_SOURCE === '1') roots.push(process.cwd());
  for (const root of roots) {
    const candidate = path.join(root, 'omp', 'hooks', OMP_HOOK_FILENAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function installOmpHooks(): Promise<number> {
  const source = findOmpHookSourcePath();
  if (!source) {
    console.error('Could not find the OMP hook bundle shipped with claude-mem.');
    console.error('  Expected at: <marketplace>/omp/hooks/claude-mem.ts');
    console.error('  Re-run `npx claude-mem install` to populate the marketplace,');
    console.error('  or set CLAUDE_MEM_DEV_HOOK_SOURCE=1 to resolve from the cwd (dev only).');
    return 1;
  }

  try {
    const destination = ompHookDestination();
    mkdirSync(ompHooksPreDir(), { recursive: true });
    writeTextFileAtomic(destination, readFileSync(source, 'utf-8'));
    console.log(`  OMP hook installed to: ${destination}`);
    logger.info('OMP', 'Hook installed', { destination });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OMP hook: ${message}`);
    return 1;
  }
}

export function uninstallOmpHooks(): number {
  try {
    const destination = ompHookDestination();
    if (!existsSync(destination)) {
      console.log('  OMP hook not installed; nothing to remove.');
      return 0;
    }
    rmSync(destination, { force: true });
    console.log(`  Removed OMP hook: ${destination}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to remove OMP hook: ${message}`);
    return 1;
  }
}
