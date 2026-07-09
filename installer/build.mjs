import { build } from 'esbuild';
import { chmodSync } from 'fs';

const outfile = 'dist/index.js';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [],
});

// The bin entry starts with a shebang, so it must be executable for `npx`
// and direct invocation to work. esbuild does not set the execute bit.
chmodSync(outfile, 0o755);

console.log('Build complete: dist/index.js');
