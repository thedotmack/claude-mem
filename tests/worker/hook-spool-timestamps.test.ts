import { it } from 'bun:test';
import { join } from 'node:path';
import { runOwnedFixture } from '../helpers/owned-fixture.js';

it('retains capture timestamps on fresh live handoffs and their stored results', async () => {
  await runOwnedFixture('tests/fixtures/worker/hook-spool-timestamps.ts', {
    prefix: 'hook-spool-timestamps-',
    env: dataDir => ({ CLAUDE_CONFIG_DIR: join(dataDir, 'claude') }),
  });
}, 10000);
