import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { commandExists, runCommand, expandHome, detectOS } from './system.js';

export interface BinaryInfo {
  found: boolean;
  path: string | null;
  version: string | null;
}

export function findBinary(name: string, extraPaths: string[] = []): BinaryInfo {
  // Check PATH first
  if (commandExists(name)) {
    const result = runCommand('which', [name]);
    const versionResult = runCommand(name, ['--version']);
    return {
      found: true,
      path: result.stdout,
      version: parseVersion(versionResult.stdout) || parseVersion(versionResult.stderr),
    };
  }

  // Check extra known locations
  for (const extraPath of extraPaths) {
    const fullPath = expandHome(extraPath);
    if (existsSync(fullPath)) {
      const versionResult = runCommand(fullPath, ['--version']);
      return {
        found: true,
        path: fullPath,
        version: parseVersion(versionResult.stdout) || parseVersion(versionResult.stderr),
      };
    }
  }

  return { found: false, path: null, version: null };
}

function parseVersion(output: string): string | null {
  if (!output) return null;
  const match = output.match(/(\d+\.\d+(\.\d+)?)/);
  return match ? match[1] : null;
}

export function compareVersions(current: string, minimum: string): boolean {
  const currentParts = current.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let i = 0; i < Math.max(currentParts.length, minimumParts.length); i++) {
    const a = currentParts[i] || 0;
    const b = minimumParts[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // equal
}

export function installBun(): void {
  const os = detectOS();
  if (os === 'windows') {
    execSync('powershell -c "irm bun.sh/install.ps1 | iex"', { stdio: 'inherit' });
  } else {
    execSync('curl -fsSL https://bun.sh/install | bash', { stdio: 'inherit' });
  }
}

export function installUv(): void {
  const os = detectOS();
  if (os === 'windows') {
    execSync('powershell -c "irm https://astral.sh/uv/install.ps1 | iex"', { stdio: 'inherit' });
  } else {
    execSync('curl -fsSL https://astral.sh/uv/install.sh | sh', { stdio: 'inherit' });
  }
}
