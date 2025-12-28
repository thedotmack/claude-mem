#!/usr/bin/env node
/**
 * Smart Install Script for claude-mem
 *
 * Ensures Bun runtime and uv (Python package manager) are installed
 * (auto-installs if missing) and handles dependency installation when needed.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';

const ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const MARKER = join(ROOT, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

// Common installation paths (handles fresh installs before PATH reload)
const BUN_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
  : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];

const UV_COMMON_PATHS = IS_WINDOWS
  ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
  : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];

/**
 * Determines if shell should be used for spawnSync on Windows.
 *
 * On Windows, using shell: true with spawnSync can cause:
 * - DEP0190 deprecation warnings about unescaped arguments
 * - libuv assertion failures (UV_HANDLE_CLOSING race condition)
 *
 * We only need shell: true when:
 * - Running a bare command name that requires PATH resolution
 * - The executable path is not absolute
 *
 * When we have a full path to an .exe, we can run it directly without shell.
 *
 * @param {string} executablePath - The path or command to execute
 * @returns {boolean} - Whether to use shell option
 */
function needsShell(executablePath) {
  if (!IS_WINDOWS) return false;
  // If it's an absolute path (like C:\Users\...\bun.exe), no shell needed
  if (isAbsolute(executablePath)) return false;
  // Bare command names need shell for PATH resolution on Windows
  return true;
}

/**
 * Check if Bun is installed and accessible
 */
function isBunInstalled() {
  return getBunPath() !== null;
}

/**
 * Get the Bun executable path (from PATH or common install locations)
 * Prioritizes full paths to avoid shell usage on Windows.
 */
function getBunPath() {
  // Check common installation paths first (preferred - avoids shell on Windows)
  const fullPath = BUN_COMMON_PATHS.find(existsSync);
  if (fullPath) return fullPath;

  // Fall back to PATH resolution (requires shell on Windows)
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell('bun')
    });
    if (result.status === 0) return 'bun';
  } catch {
    // Not in PATH
  }

  return null;
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
      shell: needsShell(bunPath)
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Check if uv is installed and accessible
 */
function isUvInstalled() {
  return getUvPath() !== null;
}

/**
 * Get the uv executable path (from PATH or common install locations)
 * Prioritizes full paths to avoid shell usage on Windows.
 */
function getUvPath() {
  // Check common installation paths first (preferred - avoids shell on Windows)
  const fullPath = UV_COMMON_PATHS.find(existsSync);
  if (fullPath) return fullPath;

  // Fall back to PATH resolution (requires shell on Windows)
  try {
    const result = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell('uv')
    });
    if (result.status === 0) return 'uv';
  } catch {
    // Not in PATH
  }

  return null;
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
      shell: needsShell(uvPath)
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
      // Windows: Use PowerShell installer
      console.error('   Installing via PowerShell...');
      execSync('powershell -c "irm bun.sh/install.ps1 | iex"', {
        stdio: 'inherit',
        shell: true
      });
    } else {
      // Unix/macOS: Use curl installer
      console.error('   Installing via curl...');
      execSync('curl -fsSL https://bun.sh/install | bash', {
        stdio: 'inherit',
        shell: true
      });
    }

    // Verify installation
    if (isBunInstalled()) {
      const version = getBunVersion();
      console.error(`✅ Bun ${version} installed successfully`);
      return true;
    } else {
      // Bun may be installed but not in PATH yet for this session
      // Try common installation paths
      const bunPaths = IS_WINDOWS
        ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
        : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];

      for (const bunPath of bunPaths) {
        if (existsSync(bunPath)) {
          console.error(`✅ Bun installed at ${bunPath}`);
          console.error('⚠️  Please restart your terminal or add Bun to PATH:');
          if (IS_WINDOWS) {
            console.error(`   $env:Path += ";${join(homedir(), '.bun', 'bin')}"`);
          } else {
            console.error(`   export PATH="$HOME/.bun/bin:$PATH"`);
          }
          return true;
        }
      }

      throw new Error('Bun installation completed but binary not found');
    }
  } catch (error) {
    console.error('❌ Failed to install Bun automatically');
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
      // Windows: Use PowerShell installer
      console.error('   Installing via PowerShell...');
      execSync('powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"', {
        stdio: 'inherit',
        shell: true
      });
    } else {
      // Unix/macOS: Use curl installer
      console.error('   Installing via curl...');
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: 'inherit',
        shell: true
      });
    }

    // Verify installation
    if (isUvInstalled()) {
      const version = getUvVersion();
      console.error(`✅ uv ${version} installed successfully`);
      return true;
    } else {
      // uv may be installed but not in PATH yet for this session
      // Try common installation paths
      const uvPaths = IS_WINDOWS
        ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
        : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];

      for (const uvPath of uvPaths) {
        if (existsSync(uvPath)) {
          console.error(`✅ uv installed at ${uvPath}`);
          console.error('⚠️  Please restart your terminal or add uv to PATH:');
          if (IS_WINDOWS) {
            console.error(`   $env:Path += ";${join(homedir(), '.local', 'bin')}"`);
          } else {
            console.error(`   export PATH="$HOME/.local/bin:$PATH"`);
          }
          return true;
        }
      }

      throw new Error('uv installation completed but binary not found');
    }
  } catch (error) {
    console.error('❌ Failed to install uv automatically');
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
 * Install the claude-mem CLI command to PATH
 * Creates a wrapper script in ~/.local/bin (Unix) or %LOCALAPPDATA%\Programs\claude-mem (Windows)
 */
function installCLI() {
  const CLI_NAME = 'claude-mem';
  const WORKER_CLI = join(ROOT, 'plugin', 'scripts', 'worker-cli.js');

  if (IS_WINDOWS) {
    // Windows: Create .cmd file in LocalAppData
    const cliDir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'claude-mem');
    const cliPath = join(cliDir, `${CLI_NAME}.cmd`);
    const markerPath = join(cliDir, '.cli-installed');

    // Skip if already installed
    if (existsSync(markerPath)) return;

    try {
      // Create directory if needed
      if (!existsSync(cliDir)) {
        execSync(`mkdir "${cliDir}"`, { stdio: 'ignore', shell: true });
      }

      // Get Bun path for the wrapper
      const bunPath = getBunPath() || 'bun';

      // Create the wrapper script
      const cmdContent = `@echo off
"${bunPath}" "${WORKER_CLI}" %*
`;
      writeFileSync(cliPath, cmdContent);
      writeFileSync(markerPath, new Date().toISOString());

      console.error(`✅ CLI installed: ${cliPath}`);
      console.error('');
      console.error('📋 Add to PATH (run once in PowerShell as Admin):');
      console.error(`   [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${cliDir}", "User")`);
      console.error('');
      console.error('   Then restart your terminal and use: npm run worker:start|stop|restart|status');
    } catch (error) {
      console.error(`⚠️  Could not install CLI: ${error.message}`);
      console.error(`   You can still use: bun "${WORKER_CLI}" <command>`);
    }
  } else {
    // Unix: Create shell script in ~/.local/bin
    const cliDir = join(homedir(), '.local', 'bin');
    const cliPath = join(cliDir, CLI_NAME);
    const markerPath = join(ROOT, '.cli-installed');

    // Skip if already installed
    if (existsSync(markerPath) && existsSync(cliPath)) return;

    try {
      // Create directory if needed
      if (!existsSync(cliDir)) {
        execSync(`mkdir -p "${cliDir}"`, { stdio: 'ignore', shell: true });
      }

      // Get Bun path for the wrapper
      const bunPath = getBunPath() || 'bun';

      // Create the wrapper script
      const shContent = `#!/usr/bin/env bash
# claude-mem CLI wrapper - manages the worker service
exec "${bunPath}" "${WORKER_CLI}" "$@"
`;
      writeFileSync(cliPath, shContent, { mode: 0o755 });
      writeFileSync(markerPath, new Date().toISOString());

      console.error(`✅ CLI installed: ${cliPath}`);

      // Check if ~/.local/bin is in PATH
      const pathDirs = (process.env.PATH || '').split(':');
      const localBinInPath = pathDirs.some(p => p === cliDir || p === '$HOME/.local/bin' || p.endsWith('/.local/bin'));

      if (!localBinInPath) {
        console.error('');
        console.error('📋 Add to PATH (add to ~/.bashrc or ~/.zshrc):');
        console.error('   export PATH="$HOME/.local/bin:$PATH"');
        console.error('');
        console.error('   Then restart your terminal and use: npm run worker:start|stop|restart|status');
      } else {
        console.error('   Usage: npm run worker:start|stop|restart|status');
      }
    } catch (error) {
      console.error(`⚠️  Could not install CLI: ${error.message}`);
      console.error(`   You can still use: bun "${WORKER_CLI}" <command>`);
    }
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
 * Install dependencies using Bun with npm fallback
 *
 * Bun has issues with npm alias packages (e.g., string-width-cjs, strip-ansi-cjs)
 * that are defined in package-lock.json. When bun fails with 404 errors for these
 * packages, we fall back to npm which handles aliases correctly.
 */
function installDeps() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('📦 Installing dependencies with Bun...');

  let bunSucceeded = false;

  // Use spawnSync with array args when we have a full path (avoids shell on Windows)
  // This prevents DEP0190 warnings and libuv assertion failures
  if (isAbsolute(bunPath)) {
    try {
      const result = spawnSync(bunPath, ['install'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false
      });
      bunSucceeded = result.status === 0;
    } catch {
      // First attempt failed
    }

    if (!bunSucceeded) {
      try {
        const result = spawnSync(bunPath, ['install', '--force'], {
          cwd: ROOT,
          stdio: 'inherit',
          shell: false
        });
        bunSucceeded = result.status === 0;
      } catch {
        // Force attempt also failed
      }
    }
  } else {
    // Bare command needs shell for PATH resolution
    const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;
    try {
      execSync(`${bunCmd} install`, { cwd: ROOT, stdio: 'inherit', shell: needsShell(bunPath) });
      bunSucceeded = true;
    } catch {
      try {
        execSync(`${bunCmd} install --force`, { cwd: ROOT, stdio: 'inherit', shell: needsShell(bunPath) });
        bunSucceeded = true;
      } catch {
        // Both attempts failed
      }
    }
  }

  // Fallback to npm if bun failed (handles npm alias packages correctly)
  if (!bunSucceeded) {
    console.error('⚠️  Bun install failed, falling back to npm...');
    console.error('   (This can happen with npm alias packages like *-cjs)');
    try {
      execSync('npm install', { cwd: ROOT, stdio: 'inherit', shell: needsShell('npm') });
    } catch (npmError) {
      throw new Error('Both bun and npm install failed: ' + npmError.message);
    }
  }

  // Write version marker
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({
    version: pkg.version,
    bun: getBunVersion(),
    uv: getUvVersion(),
    installedAt: new Date().toISOString()
  }));
}

// Main execution
try {
  // Step 1: Ensure Bun is installed (REQUIRED)
  if (!isBunInstalled()) {
    installBun();

    // Re-check after installation
    if (!isBunInstalled()) {
      console.error('❌ Bun is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 2: Ensure uv is installed (REQUIRED for vector search)
  if (!isUvInstalled()) {
    installUv();

    // Re-check after installation
    if (!isUvInstalled()) {
      console.error('❌ uv is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 3: Install dependencies if needed
  if (needsInstall()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const newVersion = pkg.version;

    installDeps();
    console.error('✅ Dependencies installed');

    // Auto-restart worker to pick up new code
    const port = process.env.CLAUDE_MEM_WORKER_PORT || 37777;
    console.error(`[claude-mem] Plugin updated to v${newVersion} - restarting worker...`);
    try {
      // Graceful shutdown via HTTP (curl is cross-platform enough)
      execSync(`curl -s -X POST http://127.0.0.1:${port}/api/admin/shutdown`, {
        stdio: 'ignore',
        shell: needsShell('curl'),
        timeout: 5000
      });
      // Brief wait for port to free
      execSync(IS_WINDOWS ? 'timeout /t 1 /nobreak >nul' : 'sleep 0.5', {
        stdio: 'ignore',
        shell: true
      });
    } catch {
      // Worker wasn't running or already stopped - that's fine
    }
    // Worker will be started fresh by next hook in chain (worker-service.cjs start)
  }

  // Step 4: Install CLI to PATH
  installCLI();
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  process.exit(1);
}
