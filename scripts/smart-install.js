#!/usr/bin/env node
/**
 * Smart Install Script for claude-mem
 *
 * Ensures Bun runtime and uv (Python package manager) are installed
 * (auto-installs if missing) and handles dependency installation when needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const MARKER = join(ROOT, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

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

const CLI_MARKER = join(ROOT, '.cli-installed');

/**
 * Escape a path for safe embedding in a shell single-quoted string (bash/zsh)
 * Single quotes cannot contain single quotes, so we end the quote, add an escaped quote, and restart
 */
function escapeForShellSingleQuote(path) {
  return path.replace(/'/g, "'\\''");
}

/**
 * Escape a path for safe embedding in a PowerShell double-quoted string
 * Backticks and dollar signs need escaping
 */
function escapeForPowerShell(path) {
  return path.replace(/`/g, '``').replace(/\$/g, '`$');
}

/**
 * Install claude-mem CLI alias for all supported platforms
 */
function installCLI() {
  if (existsSync(CLI_MARKER)) return;

  const bunPath = getBunPath();
  if (!bunPath) return;

  const workerCli = join(ROOT, 'plugin', 'scripts', 'worker-service.cjs');

  try {
    if (IS_WINDOWS) {
      // Windows: PowerShell profile
      const psProfile = join(homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
      const psProfileCore = join(homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      const safeBunPath = escapeForPowerShell(bunPath);
      const safeWorkerCli = escapeForPowerShell(workerCli);
      const aliasCmd = `function claude-mem { & "${safeBunPath}" "${safeWorkerCli}" @args }`;

      for (const profile of [psProfile, psProfileCore]) {
        try {
          const profileDir = join(profile, '..');
          if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

          let content = existsSync(profile) ? readFileSync(profile, 'utf-8') : '';
          if (!content.includes('function claude-mem')) {
            writeFileSync(profile, content + '\n# claude-mem CLI\n' + aliasCmd + '\n');
            console.error(`✅ Added claude-mem CLI to ${profile}`);
          }
        } catch (e) {
          // Profile location may not be writable, try next
        }
      }
    } else {
      // macOS/Linux: Support multiple shells
      const safeBunPath = escapeForShellSingleQuote(bunPath);
      const safeWorkerCli = escapeForShellSingleQuote(workerCli);
      const aliasCmd = `alias claude-mem='${safeBunPath} "${safeWorkerCli}"'`;

      // Shell config files to check (in order of preference)
      const shellConfigs = [
        '.zshrc',      // macOS default (Catalina+), common on Linux
        '.bashrc',     // Linux default, macOS bash users
        '.bash_profile', // macOS bash (older)
        '.profile',    // Generic fallback
      ];

      let installed = false;
      for (const rcFile of shellConfigs) {
        const rcPath = join(homedir(), rcFile);
        if (existsSync(rcPath)) {
          let content = readFileSync(rcPath, 'utf-8');
          if (!content.includes("alias claude-mem=")) {
            writeFileSync(rcPath, content + '\n# claude-mem CLI\n' + aliasCmd + '\n');
            console.error(`✅ Added claude-mem CLI to ~/${rcFile}`);
            installed = true;
            break;  // Only add to one file
          } else {
            installed = true;  // Already installed
            break;
          }
        }
      }

      // If no shell config found, create .bashrc
      if (!installed) {
        const bashrc = join(homedir(), '.bashrc');
        writeFileSync(bashrc, '# claude-mem CLI\n' + aliasCmd + '\n');
        console.error('✅ Created ~/.bashrc with claude-mem CLI');
      }
    }

    writeFileSync(CLI_MARKER, JSON.stringify({
      installedAt: new Date().toISOString(),
      platform: process.platform
    }));
    console.error('   Restart your terminal to use: claude-mem generate');
  } catch (error) {
    console.error('⚠️ Could not install CLI alias:', error.message);
    console.error('   Manual installation:');
    if (IS_WINDOWS) {
      const safeBun = escapeForPowerShell(bunPath);
      const safeCli = escapeForPowerShell(workerCli);
      console.error(`   Add to PowerShell profile: function claude-mem { & "${safeBun}" "${safeCli}" @args }`);
    } else {
      const safeBun = escapeForShellSingleQuote(bunPath);
      const safeCli = escapeForShellSingleQuote(workerCli);
      console.error(`   Add to ~/.zshrc or ~/.bashrc: alias claude-mem='${safeBun} "${safeCli}"'`);
    }
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
  installCLI();
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  process.exit(1);
}
