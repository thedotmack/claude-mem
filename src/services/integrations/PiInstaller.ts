import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

export function piExtensionDirectory(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'extensions', 'claude-mem');
}
export function piExtensionPath(): string { return join(piExtensionDirectory(), 'index.js'); }

export function findPiExtensionSource(): string | null {
  const roots = [MARKETPLACE_ROOT];
  if (process.env.CLAUDE_MEM_DEV_HOOK_SOURCE === '1') roots.push(process.cwd());
  for (const root of roots) {
    const file = join(root, 'dist', 'pi-extension', 'index.js');
    if (existsSync(file)) return file;
  }
  return null;
}

export function installPiExtension(): number {
  const source = findPiExtensionSource();
  if (!source) {
    console.error('Pi extension bundle is missing. Re-run npx claude-mem install after restoring the package build.');
    return 1;
  }
  try {
    const license = resolve(dirname(source), '..', '..', 'pi', 'THIRD-PARTY-LICENSE.txt');
    if (!existsSync(license)) throw new Error('Pi contributor license is missing from the package.');
    mkdirSync(piExtensionDirectory(), { recursive: true });
    copyFileSync(license, join(piExtensionDirectory(), 'LICENSE.txt'));
    writeFileSync(join(piExtensionDirectory(), 'package.json'), JSON.stringify({ name: '@claude-mem/pi', private: true, type: 'module' }) + '\n');
    copyFileSync(source, piExtensionPath());
    console.log('Pi memory extension installed: ' + piExtensionPath() + '. Restart Pi to load it.');
    return 0;
  } catch (error) {
    console.error('Could not install Pi memory: ' + String(error));
    return 1;
  }
}
export function uninstallPiExtension(): number {
  try {
    rmSync(piExtensionPath(), { force: true });
    rmSync(join(piExtensionDirectory(), 'LICENSE.txt'), { force: true });
    rmSync(join(piExtensionDirectory(), 'package.json'), { force: true });
    if (existsSync(piExtensionDirectory()) && readdirSync(piExtensionDirectory()).length === 0) rmdirSync(piExtensionDirectory());
    return 0;
  }
  catch (error) { console.error('Could not uninstall Pi memory: ' + String(error)); return 1; }
}
export function piExtensionStatus(): number {
  const installed = existsSync(piExtensionPath());
  console.log('Pi: ' + (installed ? 'installed at ' + piExtensionPath() : 'not installed'));
  return installed ? 0 : 1;
}
