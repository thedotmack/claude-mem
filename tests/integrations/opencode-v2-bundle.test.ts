import { expect, it } from 'bun:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Host } from '@opencode/plugin/host';
// @ts-ignore build input shared with the release script
import { OPENCODE_V2_PLUGIN_BUILD_OPTIONS } from '../../scripts/opencode-plugin-build-options.js';

it('loads the release v2 definition through the current SDK host loader without runtime SDK imports', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cmem-opencode-v2-'));
  try {
    const outfile = join(folder, 'claude-mem.js');
    await build({ ...OPENCODE_V2_PLUGIN_BUILD_OPTIONS, outfile });
    const loaded = await Host.load(outfile) as { default: { id: string; setup: unknown } };
    expect(Object.keys(loaded)).toEqual(['default']);
    expect(loaded.default.id).toBe('claude-mem');
    expect(typeof loaded.default.setup).toBe('function');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
