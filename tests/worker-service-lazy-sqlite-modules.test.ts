import { describe, it, expect } from 'bun:test';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

const PLUGIN_DIR = join(import.meta.dir, '..', 'plugin');
const WORKER_SCRIPTS_DIR = join(PLUGIN_DIR, 'scripts');
const SESSION_STORE_PATH = join(PLUGIN_DIR, 'sqlite', 'SessionStore.js');
const OBSERVATIONS_FILES_PATH = join(PLUGIN_DIR, 'sqlite', 'observations', 'files.js');

const require = createRequire(import.meta.url);

// ChromaSync.ts (bundled into worker-service.cjs) reaches these two modules
// via createRequire(import.meta.url)('../sqlite/....js') at runtime, not a
// static `import` — intentionally, so tsup's cmem-sdk build doesn't follow
// them and drag `bun:sqlite` into SDK consumers. esbuild's worker-service
// bundle does not statically resolve that indirection either, so unless the
// build also emits these as loose files next to the bundle, the runtime
// require throws `Cannot find module '../sqlite/SessionStore.js'` on every
// worker startup and the Chroma backfill pipeline is silently skipped (#3092).
describe('worker-service.cjs lazy-loaded SQLite modules (#3092)', () => {
  it('emits sqlite/SessionStore.js next to the worker bundle', () => {
    expect(existsSync(SESSION_STORE_PATH)).toBe(true);
  });

  it('emits sqlite/observations/files.js next to the worker bundle', () => {
    expect(existsSync(OBSERVATIONS_FILES_PATH)).toBe(true);
  });

  it('resolves sqlite/SessionStore.js the same way ChromaSync.ts requires it at runtime', () => {
    const { SessionStore } = require(join(WORKER_SCRIPTS_DIR, '../sqlite/SessionStore.js'));
    expect(typeof SessionStore).toBe('function');
  });

  it('resolves sqlite/observations/files.js with a working parseFileList export', () => {
    const { parseFileList } = require(join(WORKER_SCRIPTS_DIR, '../sqlite/observations/files.js'));
    expect(parseFileList('["a.ts","b.ts"]')).toEqual(['a.ts', 'b.ts']);
    expect(parseFileList(null)).toEqual([]);
  });
});
