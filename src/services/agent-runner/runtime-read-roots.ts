import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const TARGETS: Record<string, [string, string]> = {
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'android-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'android-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
};

function realPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
function packageName(path: string): string | null {
  try { return JSON.parse(readFileSync(path, 'utf8')).name ?? null; } catch { return null; }
}

/** Runtime-only read roots for native installs and the official npm launcher.
 * The npm launcher resolves its platform package, falling back to its own
 * vendor directory. Mirror that lookup without executing the launcher.
 * https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js
 */
export function runtimeReadRoots(executable: string, platform: string = process.platform, arch: string = process.arch): string[] {
  const resolved = realPath(executable);
  const roots = new Set([dirname(executable), dirname(resolved)]);
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) return [...roots];
  try {
    const require = createRequire(resolved);
    const adjacent = join(dirname(resolved), '..', 'package.json');
    const manifest = packageName(adjacent) === '@openai/codex'
      ? adjacent : require.resolve('@openai/codex/package.json');
    if (packageName(manifest) !== '@openai/codex') return [...roots];
    let vendor = join(dirname(manifest), 'vendor');
    try {
      const nativeManifest = require.resolve(`${target[0]}/package.json`);
      // npm publishes platform packages as aliases whose manifest name remains @openai/codex.
      if ([target[0], '@openai/codex'].includes(packageName(nativeManifest) ?? '')) vendor = join(dirname(nativeManifest), 'vendor');
    } catch { /* Older distributions bundle vendor directly in @openai/codex. */ }
    const runtime = join(vendor, target[1]);
    if (existsSync(join(runtime, 'bin', platform === 'win32' ? 'codex.exe' : 'codex'))) roots.add(realPath(runtime));
  } catch { /* Native installs and unknown layouts retain only their executable directories. */ }
  return [...roots];
}
