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
const IS_WINDOWS = process.platform === 'win32';

/**
 * Check if Bun is installed and accessible
 */
function isBunInstalled() {
  try {
    const result = spawnSync('bun', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return true;
  } catch {
    // PATH check failed, try common installation paths
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];

  return bunPaths.some(existsSync);
}

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
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun'];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) return bunPath;
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
      shell: IS_WINDOWS
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
  try {
    const result = spawnSync('uv', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS
    });
    if (result.status === 0) return true;
  } catch {
    // PATH check failed, try common installation paths
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  const uvPaths = IS_WINDOWS
    ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
    : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv'];

  return uvPaths.some(existsSync);
}

/**
 * Get uv version if installed
 */
function getUvVersion() {
  try {
    const result = spawnSync('uv', ['--version'], {
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
      console.error('   Then restart your terminal and use: claude-mem start|stop|restart|status');
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
        console.error('   Then restart your terminal and use: claude-mem start|stop|restart|status');
      } else {
        console.error('   Usage: claude-mem start|stop|restart|status');
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

  // Quote path for Windows paths with spaces
  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  let bunSucceeded = false;
  try {
    execSync(`${bunCmd} install`, { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });
    bunSucceeded = true;
  } catch {
    // First attempt failed, try with force flag
    try {
      execSync(`${bunCmd} install --force`, { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });
      bunSucceeded = true;
    } catch {
      // Bun failed completely, will try npm fallback
    }
  }

  // Fallback to npm if bun failed (handles npm alias packages correctly)
  if (!bunSucceeded) {
    console.error('⚠️  Bun install failed, falling back to npm...');
    console.error('   (This can happen with npm alias packages like *-cjs)');
    try {
      execSync('npm install', { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });
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
    installDeps();
    console.error('✅ Dependencies installed');
  }

  // Step 4: Install CLI to PATH
  installCLI();
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  process.exit(1);
}
