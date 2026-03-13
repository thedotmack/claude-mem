#!/usr/bin/env node
/**
 * Smart Install Script for claude-mem
 *
 * Ensures Bun runtime and uv (Python package manager) are installed
 * (auto-installs if missing) and handles dependency installation when needed.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Resolve the plugin root directory where dependencies should be installed.
 *
 * Priority:
 * 1. CLAUDE_PLUGIN_ROOT env var (set by Claude Code for hooks — works for
 *    both cache-based and marketplace installs)
 * 2. Script location (dirname of this file, up one level from scripts/)
 * 3. XDG path (~/.config/claude/plugins/marketplaces/thedotmack)
 * 4. Legacy path (~/.claude/plugins/marketplaces/thedotmack)
 */
function resolveRoot() {
  // CLAUDE_PLUGIN_ROOT is the authoritative location set by Claude Code
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }

  // Derive from script location (this file is in <root>/scripts/)
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // import.meta.url not available
  }

  // Probe XDG path, then legacy
  const marketplaceRel = join('plugins', 'marketplaces', 'thedotmack');
  const xdg = join(homedir(), '.config', 'claude', marketplaceRel);
  if (existsSync(join(xdg, 'package.json'))) return xdg;

  return join(homedir(), '.claude', marketplaceRel);
}

const ROOT = resolveRoot();
const MARKER = join(ROOT, '.install-version');

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

const UV_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

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
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true
      });
    } else {
      console.error('   Installing via curl...');
      execSync('curl -fsSL https://bun.sh/install | bash', {
        stdio: ['pipe', 'pipe', 'inherit'],
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
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true
      });
    } else {
      console.error('   Installing via curl...');
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: ['pipe', 'pipe', 'inherit'],
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

  execSync(`${bunCmd} install`, { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });

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
 * Verify that critical runtime modules are resolvable from the install directory.
 * Returns true if all critical modules exist, false otherwise.
 */
function verifyCriticalModules() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const dependencies = Object.keys(pkg.dependencies || {});

  const missing = [];
  for (const dep of dependencies) {
    const modulePath = join(ROOT, 'node_modules', ...dep.split('/'));
    if (!existsSync(modulePath)) {
      missing.push(dep);
    }
  }

  if (missing.length > 0) {
    console.error(`❌ Post-install check failed: missing modules: ${missing.join(', ')}`);
    return false;
  }

  return true;
}

// Main execution
try {
  if (!isBunInstalled()) installBun();
  if (!isUvInstalled()) installUv();
  if (needsInstall()) {
    installDeps();

    if (!verifyCriticalModules()) {
      console.error('❌ Dependencies could not be installed. Plugin may not work correctly.');
      process.exit(1);
    }

    console.error('✅ Dependencies installed');
  }
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  process.exit(1);
}

// Output valid JSON to stdout so Claude Code's hook system doesn't error
console.log(JSON.stringify({ status: 'ok' }));
