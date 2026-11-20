/**
 * esbuild options for the OpenCode plugin bundle (dist/opencode-plugin/index.js).
 *
 * Shared by scripts/build-hooks.js and the bundle export-contract test in
 * tests/integrations/opencode-plugin-contract.test.ts, so the test builds the
 * same artifact users receive. OpenCode calls every export of that file as a
 * plugin factory (#4197), and a bundler setting can change what it exports.
 * Callers add `outfile`.
 */
export const OPENCODE_PLUGIN_BUILD_OPTIONS = {
  entryPoints: ['src/integrations/opencode-plugin/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  minify: true,
  logLevel: 'error',
  external: [
    'fs', 'fs/promises', 'path', 'os', 'child_process', 'url',
    'crypto', 'http', 'https', 'net', 'stream', 'util', 'events',
  ],
};
