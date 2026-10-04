/** Shared by the release build and contract tests: installed modules need no node_modules. */
export const PI_EXTENSION_BUILD_OPTIONS = {
  entryPoints: ['src/integrations/pi-extension/index.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  minify: true, logLevel: 'error',
  banner: { js: '/*! Pi memory design and text extraction: Copyright (c) 2026 Husni Adil Makmur. MIT license; see LICENSE.txt beside the installed extension. */' },
};
export const DSH_PLUGIN_BUILD_OPTIONS = {
  entryPoints: ['src/integrations/dsh-plugin/index.ts'],
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  minify: true, logLevel: 'error',
  banner: { js: 'import { createRequire as __cmCreateRequire } from "node:module"; const require = __cmCreateRequire(import.meta.url);' },
};
