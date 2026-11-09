import { build } from 'esbuild';
import path from 'node:path';

// Embed the same child in CJS and single-file releases. Runtime spawning needs
// neither a source checkout nor node_modules nor a writable temporary directory.
export function deepSearchBuildPlugin(root = process.cwd()) {
  let contents;
  return { name: 'embedded-deep-search', setup(builder) {
    builder.onLoad({ filter: /[/\\]deep-search[/\\]child-program\.ts$/ }, async () => {
      contents ??= build({ entryPoints: [path.join(root, 'src/services/deep-search/child.ts')],
        bundle: true, platform: 'node', format: 'esm', target: 'node18', minify: true,
        external: ['bun:sqlite'], write: false }).then(result =>
          `export async function getDeepSearchProgram() { return ${JSON.stringify(result.outputFiles[0].text)}; }`);
      return { contents: await contents, loader: 'js' };
    });
  } };
}
