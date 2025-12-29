#!/usr/bin/env node
/**
 * Smart Install Script for claude-mem
 *
 * Ensures Bun runtime and uv (Python package manager) are installed
 * (auto-installs if missing) and handles dependency installation when needed.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const MARKER = join(ROOT, '.install-version');
const WORKER_MARKER = join(ROOT, '.worker-binary-version');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];

const UV_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];

/**
 * Get the Bun executable path (from PATH or common install locations)
 */
function getBunPath() {
  // Try PATH first
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }

  // Check common installation paths
  return BUN_COMMON_PATHS.find(existsSync) || null;
}

/**
 * Check if Bun is installed and accessible
 */
function isBunInstalled() {
  return getBunPath() !== null;
}

/**
 * Get Bun version if installed
 */
function getBunVersion() {
  const bunPath = getBunPath();
  if (!bunPath) return null;

  try {
    const result = spawnSync(bunPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Get the uv executable path (from PATH or common install locations)
 */
function getUvPath() {
  // Try PATH first
  try {
    const result = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return 'uv';
  } catch {
    // Not in PATH
  }

  // Check common installation paths
  return UV_COMMON_PATHS.find(existsSync) || null;
}

/**
 * Check if uv is installed and accessible
 */
function isUvInstalled() {
  return getUvPath() !== null;
}

/**
 * Get uv version if installed
 */
function getUvVersion() {
  const uvPath = getUvPath();
  if (!uvPath) return null;

  try {
    const result = spawnSync(uvPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Install Bun automatically based on platform
 */
function installBun() {
  console.error('🔧 Bun not found. Installing Bun runtime...');

  try {
    if (IS_WINDOWS) {
      console.error('   Installing via PowerShell...');
      execSync('powershell -c "irm bun.sh/install.ps1 | iex"', {
        stdio: 'inherit',
        shell: true
      });
    } else {
      console.error('   Installing via curl...');
      execSync('curl -fsSL https://bun.sh/install | bash', {
        stdio: 'inherit',
        shell: true
      });
    }

    if (!isBunInstalled()) {
      throw new Error(
        'Bun installation completed but binary not found. ' +
        'Please restart your terminal and try again.'
      );
    }

    const version = getBunVersion();
    console.error(`✅ Bun ${version} installed successfully`);
  } catch (error) {
    console.error('❌ Failed to install Bun');
    console.error('   Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install Oven-sh.Bun');
      console.error('   - Or: powershell -c "irm bun.sh/install.ps1 | iex"');
    } else {
      console.error('   - curl -fsSL https://bun.sh/install | bash');
      console.error('   - Or: brew install oven-sh/bun/bun');
    }
    console.error('   Then restart your terminal and try again.');
    throw error;
  }
}

/**
 * Install uv automatically based on platform
 */
function installUv() {
  console.error('🐍 Installing uv for Python/Chroma support...');

  try {
    if (IS_WINDOWS) {
      console.error('   Installing via PowerShell...');
      execSync('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"', {
        stdio: 'inherit',
        shell: true
      });
    } else {
      console.error('   Installing via curl...');
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: 'inherit',
        shell: true
      });
    }

    if (!isUvInstalled()) {
      throw new Error(
        'uv installation completed but binary not found. ' +
        'Please restart your terminal and try again.'
      );
    }

    const version = getUvVersion();
    console.error(`✅ uv ${version} installed successfully`);
  } catch (error) {
    console.error('❌ Failed to install uv');
    console.error('   Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install astral-sh.uv');
      console.error('   - Or: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"');
    } else {
      console.error('   - curl -LsSf https://astral.sh/uv/install.sh | sh');
      console.error('   - Or: brew install uv (macOS)');
    }
    console.error('   Then restart your terminal and try again.');
    throw error;
  }
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall() {
  if (!existsSync(join(ROOT, 'node_modules'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    return pkg.version !== marker.version || getBunVersion() !== marker.bun;
  } catch {
    return true;
  }
}

/**
 * Install dependencies using Bun
 */
function installDeps() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('📦 Installing dependencies with Bun...');

  // Quote path for Windows paths with spaces
  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  execSync(`${bunCmd} install`, { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });

  // Write version marker
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({
    version: pkg.version,
    bun: getBunVersion(),
    uv: getUvVersion(),
    installedAt: new Date().toISOString()
  }));
}

/**
 * Get platform-specific Bun compile target
 */
function getBunCompileTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') return 'bun-windows-x64';
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
  }
  if (platform === 'linux') return 'bun-linux-x64';

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Check if worker executable needs to be built
 */
function needsWorkerBuild() {
  const executablePath = join(ROOT, 'plugin', 'scripts', IS_WINDOWS ? 'worker-service.exe' : 'worker-service');

  if (!existsSync(executablePath)) return true;

  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const marker = JSON.parse(readFileSync(WORKER_MARKER, 'utf-8'));
    return pkg.version !== marker.version ||
           process.platform !== marker.platform ||
           process.arch !== marker.arch;
  } catch {
    return true;
  }
}

/**
 * Build worker service executable using bun build --compile
 */
function buildWorkerExecutable() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('🔨 Building worker service executable...');

  const sourcePath = join(ROOT, 'src', 'services', 'worker-service.ts');
  const outputPath = join(ROOT, 'plugin', 'scripts', IS_WINDOWS ? 'worker-service.exe' : 'worker-service');
  const target = getBunCompileTarget();

  if (!existsSync(sourcePath)) {
    throw new Error(`Worker source not found: ${sourcePath}`);
  }

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
  const sourceArg = sourcePath.includes(' ') ? `"${sourcePath}"` : sourcePath;
  const outputArg = outputPath.includes(' ') ? `"${outputPath}"` : outputPath;

  try {
    execSync(`${bunCmd} build --compile --target=${target} ${sourceArg} --outfile ${outputArg}`, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WINDOWS
    });

    // Write version marker
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    writeFileSync(WORKER_MARKER, JSON.stringify({
      version: pkg.version,
      platform: process.platform,
      arch: process.arch,
      target: target,
      builtAt: new Date().toISOString()
    }));

    console.error(`✅ Worker executable built (${target})`);
  } catch (error) {
    console.error('❌ Failed to build worker executable');
    throw error;
  }
}

// Main execution
try {
  if (!isBunInstalled()) installBun();
  if (!isUvInstalled()) installUv();
  if (needsInstall()) {
    installDeps();
    console.error('✅ Dependencies installed');
  }
  if (needsWorkerBuild()) {
    buildWorkerExecutable();
  }
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  process.exit(1);
}
