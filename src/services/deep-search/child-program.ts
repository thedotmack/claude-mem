import { fileURLToPath } from 'node:url';

// Release builds replace this module with the embedded child program. Source
// execution bundles lazily, inside the request's deadline, without writing files.
let program: Promise<string> | undefined;
export function getDeepSearchProgram(): Promise<string> {
  return program ??= (async () => {
    const build = await Bun.build({ entrypoints: [fileURLToPath(new URL('./child.ts', import.meta.url))],
      target: 'bun', format: 'esm', minify: true });
    if (!build.success) throw new Error('Deep search child build failed');
    return build.outputs[0].text();
  })().catch(error => { program = undefined; throw error; });
}
