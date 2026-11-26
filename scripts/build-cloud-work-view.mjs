// Build the same portable, self-contained server entry for a Pro checkout or CI.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'dist/cloud-work-view.mjs');
await build({
  absWorkingDir: root, entryPoints: ['src/services/work-view/cloud-renderer.ts'], outfile,
  bundle: true, platform: 'node', format: 'esm', target: 'node20', charset: 'utf8',
  banner: { js: '// Generated from claude-mem/scripts/build-cloud-work-view.mjs.' },
});
// A vendored adapter supplies its own narrower host declarations.
if (!process.argv[2]) {
  await copyFile(resolve(root, 'integrations/cloud-work-view/types/index.d.mts'), resolve(root, 'dist/cloud-work-view.d.mts'));
  // Ship the same card and action types consumed by the UI; the installed package has no src directory.
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--skipLibCheck',
    '--declaration', '--emitDeclarationOnly', '--target', 'es2022', '--module', 'nodenext',
    '--outDir', resolve(root, 'dist'), resolve(root, 'src/shared/review-stack.ts')], { stdio: 'inherit' });
}
