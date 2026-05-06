import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const IS_WINDOWS = process.platform === 'win32';

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
        shell: process.env.ComSpec ?? 'cmd.exe',
      });
    } else {
      execSync('curl -fsSL https://bun.sh/install | bash', {
        stdio: 'pipe',
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
        shell: process.env.ComSpec ?? 'cmd.exe',
      });
    } else {
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: 'pipe',
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

function verifyCriticalModules(targetDir: string): void {
  const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
  const dependencies = Object.keys(pkg.dependencies || {});

  const missing: string[] = [];
  for (const dep of dependencies) {
    const modulePath = join(targetDir, 'node_modules', ...dep.split('/'));
    if (!existsSync(modulePath)) {
      missing.push(dep);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Post-install check failed: missing modules: ${missing.join(', ')}`);
  }
}

export async function ensureBun(): Promise<{ bunPath: string; version: string }> {
  if (!isBunInstalled()) {
    installBun();
  }
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found after install attempt.');
  }
  const version = getBunVersion();
  if (!version) {
    throw new Error('Bun installed but version probe failed.');
  }
  return { bunPath, version };
}

export async function ensureUv(): Promise<{ uvPath: string; version: string }> {
  if (!isUvInstalled()) {
    installUv();
  }
  const uvPath = getUvPath();
  if (!uvPath) {
    throw new Error('uv executable not found after install attempt.');
  }
  const version = getUvVersion();
  if (!version) {
    throw new Error('uv installed but version probe failed.');
  }
  return { uvPath, version };
}

export async function installPluginDependencies(targetDir: string, bunPath: string): Promise<void> {
  if (!existsSync(join(targetDir, 'package.json'))) {
    throw new Error(`installPluginDependencies: no package.json at ${targetDir}`);
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  try {
    execSync(`${bunCmd} install`, {
      cwd: targetDir,
      stdio: 'pipe',
      ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
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
