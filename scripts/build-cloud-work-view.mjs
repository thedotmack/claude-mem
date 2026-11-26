// Build the same portable, self-contained server entry for a Pro checkout or CI.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { copyFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'dist/cloud-work-view.mjs');
await build({
  absWorkingDir: root, entryPoints: ['src/services/work-view/cloud-renderer.ts'], outfile,
  bundle: true, platform: 'node', format: 'esm', target: 'node20', charset: 'utf8',
  banner: { js: '// Generated from claude-mem/scripts/build-cloud-work-view.mjs.' },
});
// A vendored adapter supplies its own narrower host declarations.
if (!process.argv[2]) await copyFile(resolve(root, 'integrations/cloud-work-view/types/index.d.mts'), resolve(root, 'dist/cloud-work-view.d.mts'));
