import { existsSync, readFileSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

/**
 * Completeness of a plugin root's declared dependency closure — the contract
 * `verifyCriticalModules` (src/npx-cli/install/setup-runtime.ts) asserts after
 * an install and plugin/scripts/version-check.js (`findMissingDependencies`)
 * applies at Setup. version-check.js is standalone JS run by the host's node,
 * so it cannot import this; keep the two in lockstep.
 *
 * Presence is checked by statting `<root>/node_modules/<dep>/package.json`,
 * never by require.resolve: Node's lookup walks every ancestor directory and
 * the global folders, so a copy above the plugin root would report a gutted
 * tree as complete (gh #3872 review). zod's subpaths are `exports`-map entries,
 * so those alone are resolved, anchored inside the tree and checked to land in
 * this root's own zod (gh #2730, #3755).
 */
const ZOD_REQUIRED_SUBPATHS = ['zod/v3', 'zod/v4', 'zod/v4-mini'] as const;

function realpathOrSelf(candidatePath: string): string {
  try {
    return realpathSync(candidatePath);
  } catch {
    return candidatePath;
  }
}

function isInsideDir(candidatePath: string, dirPath: string): boolean {
  const rel = path.relative(dirPath, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The declared dependencies of `pluginRoot` that its own node_modules does not
 * provide; empty when the closure is complete. A root with no readable
 * package.json or no declared dependencies is complete by definition.
 */
export function findMissingPluginDependencies(pluginRoot: string): string[] {
  let declared: string[];
  try {
    const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> };
    declared = Object.keys(manifest?.dependencies ?? {});
  } catch {
    return [];
  }
  if (declared.length === 0) return [];

  const nodeModulesPath = path.join(pluginRoot, 'node_modules');
  const missing = declared.filter(dep => !existsSync(path.join(nodeModulesPath, ...dep.split('/'), 'package.json')));

  if (declared.includes('zod') && !missing.includes('zod')) {
    const requireFromPlugin = createRequire(path.join(nodeModulesPath, 'noop.js'));
    const zodDir = realpathOrSelf(path.join(nodeModulesPath, 'zod'));
    for (const subpath of ZOD_REQUIRED_SUBPATHS) {
      try {
        const resolved = requireFromPlugin.resolve(subpath, { paths: [nodeModulesPath] });
        if (!isInsideDir(realpathOrSelf(resolved), zodDir)) missing.push(subpath);
      } catch {
        missing.push(subpath);
      }
    }
  }
  return missing;
}
