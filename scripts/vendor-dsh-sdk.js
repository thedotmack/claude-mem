/** Regenerate the three SDK helpers without adding SDK peer graphs to installs.
 * Install the pinned packages in an isolated directory with npm --legacy-peer-deps,
 * then set DSH_SDK_NODE_MODULES to that directory's node_modules and run this file.
 * The normal release build consumes the checked-in helper; it performs no install.
 */
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const modules = resolve(process.env.DSH_SDK_NODE_MODULES || 'node_modules');
const destination = 'src/integrations/dsh-plugin/vendor';
mkdirSync(destination, { recursive: true });
await build({
  stdin: {
    contents: 'export { default as Schema } from "@deepseek-ai/schemastery"; export { defineTool } from "@deepseek-ai/dsh-tools"; export { createUserMessage } from "@deepseek-ai/dsh-llm";',
    resolveDir: process.cwd(), sourcefile: 'dsh-sdk-helpers.js',
  },
  nodePaths: [modules], bundle: true, platform: 'node', target: 'node20', format: 'esm', minify: true,
  outfile: join(destination, 'sdk.mjs'),
  banner: { js: '/*! Vendored DeepSeek public SDK helpers. See dsh/THIRD-PARTY-LICENSES.txt and vendor/provenance.json. */\nimport { createRequire as __cmSdkRequire } from "node:module"; const require = __cmSdkRequire(import.meta.url);' },
  plugins: [{ name: 'inline-sdk-version', setup(bundler) {
    bundler.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, async args => {
      let contents = readFileSync(args.path, 'utf8');
      const metadataRead = 'createRequire(import.meta.url)("../package.json")';
      if (contents.split(metadataRead).length !== 2) throw new Error('DSH metadata-read contract changed; review the SDK update.');
      const { version } = JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh-llm/package.json'), 'utf8'));
      // A dependency's dynamic relative manifest read would otherwise point at
      // the installed plugin's manifest after bundling, changing SDK identity.
      contents = contents.replace(metadataRead, JSON.stringify({ version }));
      return { contents, loader: 'js' };
    });
  } }],
});
const names = ['schemastery','cordis','cosmokit','dsh-tools','dsh-llm','dsh-timeout','dsh-scope','dsh-session'];
const provenance = names.map(name => {
  const manifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai', name, 'package.json'), 'utf8'));
  return { name: manifest.name, version: manifest.version, license: manifest.license,
    source: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}` };
});
writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ helpers: ['Schema','defineTool','createUserMessage'], dependencies: provenance }, null, 2) + '\n');
console.log('Vendored DSH SDK helpers. Review and retain licenses when updating the pinned packages.');
