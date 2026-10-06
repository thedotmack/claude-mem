import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePiExtensionBuild, preflightDshAttribution, DSH_PLUGIN_BUILD_OPTIONS } from '../../scripts/harness-plugin-build-options.js';

describe('installed harness bundles', () => {
  it('loads Pi outside the checkout with no node_modules and registers the native extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-pi-bundle-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const file = join(dir, 'index.js');
      const prepared = preparePiExtensionBuild();
      buildSync({ ...prepared.options, outfile: file });
      for (const attribution of prepared.attributionFiles) writeFileSync(join(dir, attribution.name), attribution.contents);
      expect(readFileSync(join(dir, 'LICENSE.txt'))).toEqual(readFileSync('pi/THIRD-PARTY-LICENSE.txt'));
      expect(readFileSync(join(dir, 'CLAUDE-MEM-LICENSE.txt'))).toEqual(readFileSync('LICENSE'));
      expect(readFileSync(join(dir, 'CLAUDE-MEM-NOTICE.txt'))).toEqual(readFileSync('NOTICE'));
      expect(readFileSync(join(dir, 'TYPEBOX-LICENSE.txt'))).toEqual(readFileSync('pi/TYPEBOX-LICENSE.txt'));
      const provenance = JSON.parse(readFileSync(join(dir, 'TYPEBOX-PROVENANCE.json'), 'utf8'));
      expect(provenance.version).toBe('1.1.24');
      expect(createHash('sha256').update(readFileSync(join(dir, 'TYPEBOX-LICENSE.txt'))).digest('hex')).toBe(provenance.licenseSha256);
      const built = readFileSync(file, 'utf8');
      for (const name of ['LICENSE.txt', 'CLAUDE-MEM-LICENSE.txt', 'CLAUDE-MEM-NOTICE.txt', 'TYPEBOX-LICENSE.txt', 'TYPEBOX-PROVENANCE.json']) expect(built).toContain(name);
      const bundle = await import(pathToFileURL(file).href);
      const tools: string[] = []; const events: string[] = [];
      bundle.default({ on: (name: string) => events.push(name), registerTool: (tool: any) => tools.push(tool.name) });
      expect(tools).toHaveLength(3);
      expect(events).toContain('session_start');
      expect(events).toContain('tool_result');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });


  it('refuses absent Pi attribution before build output is created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-pi-attribution-missing-'));
    try {
      mkdirSync(join(dir, 'pi'));
      writeFileSync(join(dir, 'LICENSE'), readFileSync('LICENSE'));
      writeFileSync(join(dir, 'NOTICE'), readFileSync('NOTICE'));
      writeFileSync(join(dir, 'pi', 'THIRD-PARTY-LICENSE.txt'), readFileSync('pi/THIRD-PARTY-LICENSE.txt'));
      expect(() => preparePiExtensionBuild(dir)).toThrow();
      expect(existsSync(join(dir, 'dist'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses resolved TypeBox version or text drift rather than stamping an old notice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-pi-attribution-drift-'));
    try {
      mkdirSync(join(dir, 'pi'));
      for (const file of ['LICENSE', 'NOTICE', 'pi/THIRD-PARTY-LICENSE.txt', 'pi/TYPEBOX-LICENSE.txt', 'pi/TYPEBOX-PROVENANCE.json']) writeFileSync(join(dir, file), readFileSync(file));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { typebox: '1.1.24' } }));
      const dependency = join(dir, 'node_modules', 'typebox');
      mkdirSync(join(dependency, 'build'), { recursive: true });
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'typebox', version: '1.1.25', license: 'MIT', exports: { '.': './build/index.mjs' } }));
      writeFileSync(join(dependency, 'build', 'index.mjs'), 'export {};');
      writeFileSync(join(dependency, 'license'), readFileSync('pi/TYPEBOX-LICENSE.txt'));
      expect(() => preparePiExtensionBuild(dir)).toThrow('Resolved TypeBox does not match');
      expect(existsSync(join(dir, 'dist'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('loads DSH standalone, mounts five tools, and awaits the real creation event before the first turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-dsh-bundle-'));
    const originalFetch = globalThis.fetch;
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      mkdirSync(join(dir, 'lib'));
      // DSH resolves a package, including its manifest, rather than a bare file.
      const file = join(dir, 'lib', 'index.js');
      preflightDshAttribution();
      buildSync({ ...DSH_PLUGIN_BUILD_OPTIONS, outfile: file });
      const bundle = await import(pathToFileURL(file).href);
      const tools: any[] = []; const events = new Map<string, any>(); const requests: URL[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        requests.push(new URL(String(input))); return new Response('Project memory');
      }) as typeof fetch;
      bundle.apply({ skills: { register() {} }, tools: { register(tool: any) { tools.push(tool); } }, on(name: string, handler: any) { events.set(name, handler); } }, {
        baseUrl: 'http://remote.example:4000', timeoutMs: 5000, dedupe: true, project: '', platformSource: '',
        injectContext: true, ingest: false, summarize: false, toolFilter: { names: ['read'] },
      });
      expect(tools.map(tool => tool.name)).toEqual(['mem_search', 'mem_timeline', 'mem_get_observations', 'mem_save', 'mem_context']);
      expect([...events.keys()]).toEqual(['agent/created']);
      const injected: any[] = [];
      await events.get('agent/created')({ agent: { session: { id: 'dsh-id', header: { cwd: '/work/checkout' } }, inject(message: any) { injected.push(message); } } });
      expect(injected[0].content[0].text).toBe('Project memory');
      expect(injected[0].role).toBe('user');
      expect(injected[0].source).toEqual({ kind: 'plugin:claude-mem' });
      expect(typeof injected[0].id).toBe('string');
      expect(requests).toHaveLength(1);
      expect(requests[0].hostname).toBe('remote.example');
      expect(requests[0].searchParams.get('cwd')).toBe('/work/checkout');
      expect(requests[0].pathname).toBe('/api/context/inject');
      // Recall-only default never manufactures a prompt or saves a second observation.
    } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
  });
});
