#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

function isPluginDisabledInClaudeSettings() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.enabledPlugins?.['claude-mem@thedotmack'] === false;
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}
const IS_WINDOWS = process.platform === 'win32';

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }

  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // import.meta.url not available
  }

  const marketplaceRel = join('plugins', 'marketplaces', 'thedotmack');
  const xdg = join(homedir(), '.config', 'claude', marketplaceRel);
  if (existsSync(join(xdg, 'package.json'))) return xdg;

  return join(homedir(), '.claude', marketplaceRel);
}

const ROOT = resolveRoot();
const MARKER = join(ROOT, '.install-version');

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

  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

  return bunPaths.some(existsSync);
}

function getBunPath() {
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

  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) return bunPath;
  }

  return null;
}

const MIN_BUN_VERSION = '1.1.14';

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

function isBunVersionSufficient() {
  const version = getBunVersion();
  if (!version) return false;
  return compareVersions(version, MIN_BUN_VERSION) >= 0;
}

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

  const uvPaths = IS_WINDOWS
    ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
    : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

  return uvPaths.some(existsSync);
}

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

    if (isBunInstalled()) {
      const version = getBunVersion();
      console.error(`✅ Bun ${version} installed successfully`);
      return true;
    } else {
      const bunPaths = IS_WINDOWS
        ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
        : [join(homedir(), '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/opt/homebrew/bin/bun'];

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

    if (isUvInstalled()) {
      const version = getUvVersion();
      console.error(`✅ uv ${version} installed successfully`);
      return true;
    } else {
      const uvPaths = IS_WINDOWS
        ? [join(homedir(), '.local', 'bin', 'uv.exe'), join(homedir(), '.cargo', 'bin', 'uv.exe')]
        : [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv'), '/usr/local/bin/uv', '/opt/homebrew/bin/uv'];

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

function installDeps() {
  const bunPath = getBunPath();
  if (!bunPath) {
    throw new Error('Bun executable not found');
  }

  console.error('📦 Installing dependencies with Bun...');

  const bunCmd = IS_WINDOWS && bunPath.includes(' ') ? `"${bunPath}"` : bunPath;

  const installStdio = ['pipe', 'pipe', 'inherit'];

  let bunSucceeded = false;
  try {
    execSync(`${bunCmd} install`, { cwd: ROOT, stdio: installStdio, shell: IS_WINDOWS });
    bunSucceeded = true;
  } catch {
    try {
      execSync(`${bunCmd} install --force`, { cwd: ROOT, stdio: installStdio, shell: IS_WINDOWS });
      bunSucceeded = true;
    } catch {
      // Bun failed completely, will try npm fallback
    }
  }

  if (!bunSucceeded) {
    console.error('⚠️  Bun install failed, falling back to npm...');
    console.error('   (This can happen with npm alias packages like *-cjs)');
    try {
      execSync('npm install --legacy-peer-deps', { cwd: ROOT, stdio: installStdio, shell: IS_WINDOWS });
    } catch (npmError) {
      throw new Error('Both bun and npm install failed: ' + npmError.message);
    }
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({
    version: pkg.version,
    bun: getBunVersion(),
    uv: getUvVersion(),
    installedAt: new Date().toISOString()
  }));
}

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

const MACHO_MAGIC_NATIVE  = 0xFEEDFACF; 
const MACHO_MAGIC_SWAPPED = 0xCFFAEDFE; 

export function checkBinaryPlatformCompatibility(binaryPath = join(ROOT, 'scripts', 'claude-mem')) {

  if (!existsSync(binaryPath)) {
    return; 
  }

  if (process.platform === 'darwin') {
    return;
  }

  let fd;
  try {
    const buf = Buffer.alloc(4);
    fd = openSync(binaryPath, 'r');
    readSync(fd, buf, 0, 4, 0);

    const magic = buf.readUInt32LE(0);
    if (magic === MACHO_MAGIC_NATIVE || magic === MACHO_MAGIC_SWAPPED) {
      console.error('⚠️  Platform notice: The bundled claude-mem binary is macOS-only.');
      console.error(`   Current platform: ${process.platform} ${process.arch}`);
      console.error('   The binary will not execute on this platform.');
      console.error('   Plugin functionality is provided by the JS fallback');
      console.error('   (bun-runner.js → worker-service.cjs) which works on all platforms.');
    }
  } catch {
    // Unreadable binary — not critical, skip silently
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

try {
  if (!isBunInstalled()) {
    installBun();

    if (!isBunInstalled()) {
      console.error('❌ Bun is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  if (!isBunVersionSufficient()) {
    const currentVersion = getBunVersion();
    console.error(`⚠️  Bun ${currentVersion} is outdated. Minimum required: ${MIN_BUN_VERSION}`);
    console.error('   Upgrading bun...');
    try {
      execSync('bun upgrade', { stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });
      if (!isBunVersionSufficient()) {
        console.error(`❌ Bun upgrade failed. Please manually upgrade: bun upgrade`);
        process.exit(1);
      }
      console.error(`✅ Bun upgraded to ${getBunVersion()}`);
    } catch (error) {
      console.error(`❌ Failed to upgrade bun: ${error.message}`);
      console.error('   Please manually upgrade: bun upgrade');
      process.exit(1);
    }
  }

  if (!isUvInstalled()) {
    installUv();

    if (!isUvInstalled()) {
      console.error('❌ uv is required but not available in PATH');
      console.error('   Please restart your terminal after installation');
      process.exit(1);
    }
  }

  if (needsInstall()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const newVersion = pkg.version;

    installDeps();

    if (!verifyCriticalModules()) {
      console.error('⚠️  Retrying install with npm...');
      try {
        execSync('npm install --production --legacy-peer-deps', { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'], shell: IS_WINDOWS });
      } catch {
        // npm also failed
      }
      if (!verifyCriticalModules()) {
        console.error('❌ Dependencies could not be installed. Plugin may not work correctly.');
        process.exit(1);
      }
    }

    console.error('✅ Dependencies installed');

    const port = process.env.CLAUDE_MEM_WORKER_PORT || 37777;
    console.error(`[claude-mem] Plugin updated to v${newVersion} - restarting worker...`);
    try {
      execSync(`curl -s -X POST http://127.0.0.1:${port}/api/admin/shutdown`, {
        stdio: 'ignore',
        shell: IS_WINDOWS,
        timeout: 5000
      });
      execSync(IS_WINDOWS ? 'timeout /t 1 /nobreak >nul' : 'sleep 0.5', {
        stdio: 'ignore',
        shell: true
      });
    } catch {
      // Worker wasn't running or already stopped - that's fine
    }
    // Worker will be started fresh by next hook in chain (worker-service.cjs start)
  }

  checkBinaryPlatformCompatibility();

  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
} catch (e) {
  console.error('❌ Installation failed:', e.message);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(1);
}
