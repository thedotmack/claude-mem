import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PI_EXTENSION_BUILD_OPTIONS, DSH_PLUGIN_BUILD_OPTIONS } from '../../scripts/harness-plugin-build-options.js';

describe('installed harness bundles', () => {
  it('loads Pi outside the checkout with no node_modules and registers the native extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-pi-bundle-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const file = join(dir, 'index.js');
      buildSync({ ...PI_EXTENSION_BUILD_OPTIONS, outfile: file });
      const bundle = await import(pathToFileURL(file).href);
      const tools: string[] = []; const events: string[] = [];
      bundle.default({ on: (name: string) => events.push(name), registerTool: (tool: any) => tools.push(tool.name) });
      expect(tools).toHaveLength(3);
      expect(events).toContain('session_start');
      expect(events).toContain('tool_result');
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
