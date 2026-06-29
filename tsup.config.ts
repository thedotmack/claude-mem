import { defineConfig } from 'tsup';

// cmem-sdk build config. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §2.
//
// Scoped narrowly to the SDK entry points so the bundler does NOT drag
// in the worker, HTTP routes, BullMQ, or `bun:sqlite`. The import-guard
// (`scripts/check-sdk-bundle.cjs`) enforces this at build time.
export default defineConfig({
  entry: ['src/index.ts', 'src/sdk/index.ts'],
  format: ['esm'],
  dts: true,
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  // Do NOT wipe the rest of dist (npx-cli, opencode-plugin live there).
  clean: false,
  splitting: false,
  sourcemap: true,
  // Mark Node built-ins + the SDK's runtime deps external. tsup keeps
  // them as `import 'pg'` etc. so consumer Node apps resolve them
  // against the installed `claude-mem` package's prod deps.
  external: [
    'pg',
    'zod',
    '@modelcontextprotocol/sdk',
    '@anthropic-ai/sdk',
    /^node:/,
  ],
});
