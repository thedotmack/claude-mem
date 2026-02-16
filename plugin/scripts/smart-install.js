#!/usr/bin/env node
/**
 * Smart Install Script for magic-claude-mem
 *
 * Ensures uv (Python package manager) is installed (auto-installs if missing)
 * and handles dependency installation when needed.
 *
 * Node.js and better-sqlite3 are the only runtime requirements (no Bun needed).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// PLUGIN_ROOT = where this script actually runs (cache dir at runtime)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');

// MARKETPLACE_ROOT = stable location for CLI alias and version marker
const MARKETPLACE_ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'magic-claude-mem');
const MARKER = join(MARKETPLACE_ROOT, '.install-version');
const IS_WINDOWS = process.platform === 'win32';

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
    : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

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
 * Install uv automatically based on platform
 */
function installUv() {
  console.error('Installing uv for Python/Chroma support...');

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
      console.error(`uv ${version} installed successfully`);
      return true;
    } else {
      // uv may be installed but not in PATH yet for this session
      const uvPaths = IS_WINDOWS
        ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
        : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

      for (const uvPath of uvPaths) {
        if (existsSync(uvPath)) {
          console.error(`uv installed at ${uvPath}`);
          console.error('Please restart your terminal or add uv to PATH');
          return true;
        }
      }

      throw new Error('uv installation completed but binary not found');
    }
  } catch (error) {
    console.error('Failed to install uv automatically');
    console.error('Please install manually:');
    if (IS_WINDOWS) {
      console.error('   - winget install astral-sh.uv');
    } else {
      console.error('   - curl -LsSf https://astral.sh/uv/install.sh | sh');
    }
    throw error;
  }
}

/**
 * Add shell alias for magic-claude-mem command
 */
function installCLI() {
  const WORKER_CLI = join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
  const aliasLine = `alias magic-claude-mem='node "${WORKER_CLI}"'`;
  const markerPath = join(MARKETPLACE_ROOT, '.cli-installed');

  // Skip if already installed
  if (existsSync(markerPath)) return;

  try {
    if (IS_WINDOWS) {
      // Windows: Add to PATH via PowerShell profile
      const profilePath = join(process.env.USERPROFILE || homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
      const profileDir = join(process.env.USERPROFILE || homedir(), 'Documents', 'PowerShell');
      const functionDef = `function magic-claude-mem { & node "${WORKER_CLI}" $args }\n`;

      if (!existsSync(profileDir)) {
        execSync(`mkdir "${profileDir}"`, { stdio: 'ignore', shell: true });
      }

      const existingContent = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';
      if (!existingContent.includes('function magic-claude-mem')) {
        writeFileSync(profilePath, existingContent + '\n' + functionDef);
        console.error('PowerShell function added to profile');
        console.error('   Restart your terminal to use: magic-claude-mem <command>');
      }
    } else {
      // Unix: Add alias to shell configs
      const shellConfigs = [
        join(homedir(), '.bashrc'),
        join(homedir(), '.zshrc')
      ];

      for (const config of shellConfigs) {
        if (existsSync(config)) {
          const content = readFileSync(config, 'utf-8');
          if (!content.includes('alias magic-claude-mem=')) {
            writeFileSync(config, content + '\n' + aliasLine + '\n');
            console.error(`Alias added to ${config}`);
          }
        }
      }
      console.error('   Restart your terminal to use: magic-claude-mem <command>');
    }

    writeFileSync(markerPath, new Date().toISOString());
  } catch (error) {
    console.error(`Could not add shell alias: ${error.message}`);
    console.error(`   Use directly: node "${WORKER_CLI}" <command>`);
  }
}

/**
 * Get Node.js version
 */
function getNodeVersion() {
  return process.version;
}

/**
 * Check if dependencies need to be installed
 */
function needsInstall() {
  // Check if better-sqlite3 native addon exists in the plugin root (cache dir)
  if (!existsSync(join(PLUGIN_ROOT, 'node_modules', 'better-sqlite3'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8'));
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    // Rebuild triggers: plugin version change or pinned binary no longer exists on disk.
    // NOT triggered by Node version change — the worker uses the pinned binary,
    // so different sessions with different Node versions don't cause a tug-of-war.
    if (pkg.version !== marker.version) return true;
    if (!marker.execPath || !existsSync(marker.execPath)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Install dependencies using npm
 */
function installDeps() {
  console.error('Installing dependencies with npm...');

  try {
    execSync('npm install --production', { cwd: PLUGIN_ROOT, stdio: 'inherit', shell: IS_WINDOWS });
  } catch (npmError) {
    throw new Error('npm install failed: ' + npmError.message);
  }

  // Write version marker to marketplace (stable location across cache versions)
  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({
    version: pkg.version,
    node: getNodeVersion(),
    execPath: process.execPath,
    uv: getUvVersion(),
    installedAt: new Date().toISOString()
  }));
}

// Main execution
try {
  // Step 1: Ensure uv is installed (REQUIRED for vector search)
  if (!isUvInstalled()) {
    installUv();

    // Re-check after installation
    if (!isUvInstalled()) {
      console.error('uv is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  // Step 2: Install dependencies if needed (npm + better-sqlite3 native addon)
  if (needsInstall()) {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf-8'));
    const newVersion = pkg.version;

    installDeps();
    console.error('Dependencies installed');

    // Auto-restart worker to pick up new code
    const port = process.env.MAGIC_CLAUDE_MEM_WORKER_PORT || 37777;
    console.error(`[magic-claude-mem] Plugin updated to v${newVersion} - restarting worker...`);
    try {
      // Graceful shutdown via HTTP (curl is cross-platform enough)
      execSync(`curl -s -X POST http://127.0.0.1:${port}/api/admin/shutdown`, {
        stdio: 'ignore',
        shell: IS_WINDOWS,
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

  // Step 3: Install CLI to PATH
  installCLI();
} catch (e) {
  console.error('Installation failed:', e.message);
  process.exit(1);
}
