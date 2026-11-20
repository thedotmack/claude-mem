import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('gives the single-owner account machine room for one open My Work tab', () => {
  // With one tab open the heavy account's worker peaked at 833 MB, and a 1 GB Fly machine kills it at
  // about 868 MB (the measurements are beside the setting in fly.toml).
  const config = Bun.TOML.parse(readFileSync(join(import.meta.dir, '..', 'fly.toml'), 'utf8')) as {
    env: Record<string, string>; vm: Array<{ memory: string }>;
  };
  expect(config.env.VIEWER_ROLE).toBe('account');
  expect(config.vm.map(vm => vm.memory)).toEqual(['1536mb']);
});
