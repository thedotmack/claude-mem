import { existsSync, readFileSync, writeFileSync } from 'fs';
import { exec, execSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { join } from 'path';
import { homedir } from 'os';
import { ErrorSeverity } from './error-taxonomy.js';
import { installerError, type InstallSummary } from './error-reporter.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const IS_WINDOWS = process.platform === 'win32';

const INSTALL_TIMEOUT_MS = (() => {
  const override = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  if (override && Number.isFinite(Number(override))) return Number(override);
  return 5 * 60 * 1000;
})();

/**
 * Platform-specific manual-install instructions, surfaced as the PRIMARY ABORT
 * message when auto-install fails or the binary can't be found afterward.
 */
export function platformBunRemediation(): string {
  return IS_WINDOWS
    ? 'Install Bun manually: `winget install Oven-sh.Bun` (or `powershell -c "irm bun.sh/install.ps1 | iex"`), then re-run `npx claude-mem install`.'
    : 'Install Bun manually: `curl -fsSL https://bun.sh/install | bash` (or `brew install oven-sh/bun/bun`), then re-run `npx claude-mem install`.';
}

export function platformUvRemediation(): string {
  return IS_WINDOWS
    ? 'Install uv manually: `winget install astral-sh.uv` (or `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`), then re-run `npx claude-mem install`.'
    : 'Install uv manually: `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`), then re-run `npx claude-mem install`.';
}

function userHasOptedOutOfVectorSearch(): boolean {
  // Read the settings file directly (the value is not in the typed defaults).
  // Honors both a top-level key and an `env`-nested key.
  try {
    if (!existsSync(USER_SETTINGS_PATH)) return false;
    const raw: unknown = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object') return false;
    const record = raw as Record<string, unknown>;
    const envBlock = (record.env && typeof record.env === 'object')
      ? (record.env as Record<string, unknown>)
      : {};
    const value = record.CLAUDE_MEM_DISABLE_VECTOR_SEARCH ?? envBlock.CLAUDE_MEM_DISABLE_VECTOR_SEARCH;
    return value === true || value === 'true' || value === '1';
  } catch {
    return false;
  }
}

const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const UV_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

interface MarkerSchema {
  version: string;
  bun?: string;
  uv?: string;
  installedAt?: string;
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function markerPath(targetDir: string): string {
  return join(targetDir, '.install-version');
}

function getBunPath(): string | null {
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }

  return BUN_COMMON_PATHS.find(existsSync) || null;
}

function isBunInstalled(): boolean {
  return getBunPath() !== null;
}

function getBunVersion(): string | null {
  const bunPath = getBunPath();
  if (!bunPath) return null;

  try {
    const result = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function getUvPath(): string | null {
  try {
    const result = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    if (result.status === 0) return 'uv';
  } catch {
    // Not in PATH
  }

  return UV_COMMON_PATHS.find(existsSync) || null;
}

function isUvInstalled(): boolean {
  return getUvPath() !== null;
}

function getUvVersion(): string | null {
  const uvPath = getUvPath();
  if (!uvPath) return null;

  try {
    const result = spawnSync(uvPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function describeExecError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    if (stderr) parts.push(`stderr: ${stderr}`);
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    if (!stderr && stdout) parts.push(`stdout: ${stdout}`);
    return parts.join('\n');
  }
  return String(error);
}

function installBun(): void {
  try {
    if (IS_WINDOWS) {
      execSync('powershell -c "irm bun.sh/install.ps1 | iex"', {
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT_MS,
        shell: process.env.ComSpec ?? 'cmd.exe',
      });
    } else {
      execSync('curl -fsSL https://bun.sh/install | bash', {
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT_MS,
        shell: '/bin/bash',
      });
    }

    if (!isBunInstalled()) {
      throw new Error(
        'Bun installation completed but binary not found. Please restart your terminal and try again.',
      );
    }
  } catch (error) {
    const manualInstructions = IS_WINDOWS
      ? '  - winget install Oven-sh.Bun\n  - Or: powershell -c "irm bun.sh/install.ps1 | iex"'
      : '  - curl -fsSL https://bun.sh/install | bash\n  - Or: brew install oven-sh/bun/bun';
    throw new Error(
      `Failed to install Bun. Please install manually:\n${manualInstructions}\nThen restart your terminal and try again.\n` +
        `Underlying error: ${describeExecError(error)}`,
    );
  }
}

function installUv(): void {
  try {
    if (IS_WINDOWS) {
      execSync('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"', {
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT_MS,
        shell: process.env.ComSpec ?? 'cmd.exe',
      });
    } else {
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT_MS,
        shell: '/bin/bash',
      });
    }

    if (!isUvInstalled()) {
      throw new Error(
        'uv installation completed but binary not found. Please restart your terminal and try again.',
      );
    }
  } catch (error) {
    const manualInstructions = IS_WINDOWS
      ? '  - winget install astral-sh.uv\n  - Or: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
      : '  - curl -LsSf https://astral.sh/uv/install.sh | sh\n  - Or: brew install uv (macOS)';
    throw new Error(
      `Failed to install uv. Please install manually:\n${manualInstructions}\nThen restart your terminal and try again.\n` +
        `Underlying error: ${describeExecError(error)}`,
    );
  }
}

/**
 * Subpath imports the bundled worker requires transitively (via
 * @modelcontextprotocol/sdk / @anthropic-ai/claude-agent-sdk). A stale/partial
 * install can leave the `zod` directory present while these subpath exports fail
 * to resolve — surfacing later as a runtime `Cannot find module 'zod/v3'`. We
 * assert them at install time so a broken closure fails LOUD here. Version-agnostic:
 * we resolve subpaths, never a pinned version.
 */
const ZOD_REQUIRED_SUBPATHS = ['zod/v3', 'zod/v4', 'zod/v4-mini'] as const;

export function verifyCriticalModules(targetDir: string): void {
  const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
  const dependencies = Object.keys(pkg.dependencies || {});

  const nodeModulesPath = join(targetDir, 'node_modules');
  // A require anchored inside the install tree so require.resolve honors the
  // installed package.json `exports` map for subpath resolution.
  const requireFromTarget = createRequire(join(nodeModulesPath, 'noop.js'));
  const resolvePaths = [nodeModulesPath];

  const unresolvable: string[] = [];

  // Each declared dependency must be installed, not merely a directory on disk.
  for (const dep of dependencies) {
    try {
      requireFromTarget.resolve(dep, { paths: resolvePaths });
    } catch {
      // Bare-name resolution can fail for a perfectly-installed package that has
      // no importable entry point — e.g. bin-only packages like `tree-sitter-cli`
      // (package.json has `bin` but no `main`/`module`/`exports`/`index.js`).
      // Fall back to resolving its package.json to distinguish "installed but
      // bin-only" from "genuinely missing": a truly absent package fails both.
      // This preserves the original "is it installed" guarantee while still
      // upgrading from directory-existence to real module resolution (#2730).
      try {
        requireFromTarget.resolve(`${dep}/package.json`, { paths: resolvePaths });
      } catch {
        unresolvable.push(dep);
      }
    }
  }

  // zod ships its public API behind subpath exports the worker bundle requires.
  // The package dir existing does NOT imply these subpaths resolve (#2730).
  if (dependencies.includes('zod')) {
    for (const subpath of ZOD_REQUIRED_SUBPATHS) {
      try {
        requireFromTarget.resolve(subpath, { paths: resolvePaths });
      } catch {
        unresolvable.push(subpath);
      }
    }
  }

  if (unresolvable.length > 0) {
    throw new Error(
      `Post-install check failed: unresolvable modules: ${unresolvable.join(', ')}`,
    );
  }
}

/** Build an ephemeral summary so callers (e.g. repair) may omit it. */
function summaryOrEphemeral(summary?: InstallSummary): InstallSummary {
  return summary ?? { warnings: [], failedIDEs: [], retryCount: {} };
}

export async function ensureBun(summary?: InstallSummary): Promise<{ bunPath: string; version: string }> {
  const sum = summaryOrEphemeral(summary);
  if (!isBunInstalled()) {
    // installBun throws a platform-specific Error on failure; route it through
    // the central decision point so it becomes a loud ABORT (bun is mandatory
    // for hooks — there is no opt-out).
    try {
      installBun();
    } catch (error: unknown) {
      installerError(ErrorSeverity.ABORT, {
        component: 'bun-install',
        phase: 'setup-runtime',
        cause: error,
        remediation: platformBunRemediation(),
      }, sum);
    }
  }

  let bunPath = getBunPath();
  if (!bunPath) {
    bunPath = BUN_COMMON_PATHS.find(existsSync) ?? null;
  }
  if (!bunPath) {
    installerError(ErrorSeverity.ABORT, {
      component: 'bun-install',
      phase: 'setup-runtime',
      cause: new Error('Bun executable not found after auto-install attempt'),
      remediation: platformBunRemediation(),
    }, sum);
    throw new Error('unreachable'); // installerError(ABORT) always throws
  }

  let version = getBunVersion();
  if (!version) {
    // A fresh binary sometimes needs a moment before --version responds.
    await new Promise((r) => setTimeout(r, 1000));
    version = getBunVersion();
  }
  if (!version) {
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'bun-version-probe',
      phase: 'setup-runtime',
      cause: new Error(`Bun at ${bunPath} did not respond to --version after retry`),
    }, sum);
    return { bunPath, version: 'unknown' };
  }
  return { bunPath, version };
}

export async function ensureUv(
  summary?: InstallSummary,
  options: { allowVectorSearchOptOut?: boolean } = {},
): Promise<{ uvPath: string; version: string }> {
  const sum = summaryOrEphemeral(summary);
  if (!isUvInstalled()) {
    try {
      installUv();
    } catch (error: unknown) {
      if (options.allowVectorSearchOptOut && userHasOptedOutOfVectorSearch()) {
        installerError(ErrorSeverity.WARN_CONTINUE, {
          component: 'uv-install',
          phase: 'setup-runtime',
          cause: error,
        }, sum);
        return { uvPath: '', version: 'unknown' };
      }
      installerError(ErrorSeverity.ABORT, {
        component: 'uv-install',
        phase: 'setup-runtime',
        cause: error,
        remediation: platformUvRemediation(),
      }, sum);
    }
  }

  let uvPath = getUvPath();
  if (!uvPath) {
    // Re-probe UV_COMMON_PATHS directly — PATH may not yet include ~/.local/bin
    // in the current shell even though the install just wrote the binary there.
    uvPath = UV_COMMON_PATHS.find(existsSync) ?? null;
  }
  if (!uvPath) {
    if (options.allowVectorSearchOptOut && userHasOptedOutOfVectorSearch()) {
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'uv-install',
        phase: 'setup-runtime',
        cause: new Error('uv binary not found after install; vector search disabled — continuing.'),
      }, sum);
      return { uvPath: '', version: 'unknown' };
    }
    installerError(ErrorSeverity.ABORT, {
      component: 'uv-install',
      phase: 'setup-runtime',
      cause: new Error('uv binary not found after auto-install attempt'),
      remediation: platformUvRemediation(),
    }, sum);
    throw new Error('unreachable'); // installerError(ABORT) always throws
  }

  let version = getUvVersion();
  if (!version) {
    await new Promise((r) => setTimeout(r, 1000));
    version = getUvVersion();
  }
  if (!version) {
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'uv-version-probe',
      phase: 'setup-runtime',
      cause: new Error(`uv at ${uvPath} did not respond to --version after retry`),
    }, sum);
    return { uvPath, version: 'unknown' };
  }
  return { uvPath, version };
}

export async function installPluginDependencies(targetDir: string, bunPath: string): Promise<void> {
  if (!existsSync(join(targetDir, 'package.json'))) {
    throw new Error(`installPluginDependencies: no package.json at ${targetDir}`);
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  try {
    // Per CHANGELOG v12.6.1 -> v12.6.2: tree-sitter-swift's nested
    // tree-sitter-cli postinstall downloads a Rust binary and can hang the
    // install. Bun honors trustedDependencies; npm does not. We additionally
    // pass --ignore-scripts as belt-and-suspenders and bound it with a timeout.
    // Async exec (not execSync): a blocked event loop freezes the installer's
    // clack spinner for the duration of the install, which reads as a stall.
    await new Promise<void>((resolve, reject) => {
      exec(`${bunCmd} install --frozen-lockfile --ignore-scripts`, {
        cwd: targetDir,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
      }, (error, stdout, stderr) =>
        // exec errors don't carry stdio; attach so describeExecError can report it.
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve());
    });
  } catch (error) {
    throw new Error(`bun install failed in ${targetDir}\n${describeExecError(error)}`);
  }

  verifyCriticalModules(targetDir);
}

export function readInstallMarker(targetDir: string): MarkerSchema | null {
  const path = markerPath(targetDir);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf-8');
  try {
    const marker = JSON.parse(content);
    if (marker && typeof marker === 'object' && typeof marker.version === 'string') {
      return marker as MarkerSchema;
    }
  } catch {
    // Legacy installs wrote only the version string as plain text.
  }

  const legacyVersion = content.trim();
  if (LEGACY_VERSION_MARKER_RE.test(legacyVersion)) {
    return { version: legacyVersion.replace(/^v/i, '') };
  }

  return null;
}

export function writeInstallMarker(
  targetDir: string,
  version: string,
  bunVersion: string,
  uvVersion: string,
): void {
  const payload: MarkerSchema = {
    version,
    bun: bunVersion,
    uv: uvVersion,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(markerPath(targetDir), JSON.stringify(payload));
}

export function isInstallCurrent(targetDir: string, expectedVersion: string): boolean {
  if (!existsSync(join(targetDir, 'node_modules'))) return false;
  const marker = readInstallMarker(targetDir);
  if (!marker) return false;
  if (marker.version !== expectedVersion) return false;
  const currentBun = getBunVersion();
  if (currentBun && !marker.bun) return false;
  if (!currentBun && marker.bun) return false;
  if (currentBun && marker.bun && currentBun !== marker.bun) return false;
  return true;
}
