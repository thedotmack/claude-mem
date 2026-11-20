import { bunVersionHonoursBunBeBun, MINIMUM_BUN_VERSION_FOR_BUN_BE_BUN } from '../src/launcher/bun-be-bun-support.ts';
import { deepSearchBuildPlugin } from './deep-search-build.js';
import path from 'node:path';

/** Match build-hooks.js: mixed zod/v4 re-exports and lazy zod imports can call
 * custom() before ZodCustom is initialized. Resolve both to the same entry. */
export function workerBinaryBuildOptions({ root = process.cwd(), outfile, target, plugins = [], bunVersion = process.versions.bun }) {
  if (!bunVersionHonoursBunBeBun(bunVersion)) {
    throw new Error(`Standalone deep search requires Bun ${MINIMUM_BUN_VERSION_FOR_BUN_BE_BUN}+ to execute its child program; rebuild with a compatible Bun. This check does not change the source/runtime engine requirement.`);
  }
  return {
    entrypoints: [path.join(root, 'src/services/worker-service.ts'), path.join(root, 'src/services/context/context-read-worker.ts'), path.join(root, 'src/services/work-view/work-view-read-worker.ts')],
    target: 'bun', naming: '[name].js', minify: true,
    external: ['@opentelemetry/api', 'sharp'],
    define: { '__CMEM_MEDIA_STANDALONE__': 'true' },
    compile: { outfile, autoloadPackageJson: true, ...(target ? { target } : {}) },
    plugins: [{ name: 'single-zod-entry', setup(builder) {
      builder.onResolve({ filter: /^zod\/v4$/ }, () => ({ path: Bun.resolveSync('zod', root) }));
    } }, deepSearchBuildPlugin(root), ...plugins],
  };
}
