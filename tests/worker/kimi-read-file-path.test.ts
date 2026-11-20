import { it } from 'bun:test';
import { join } from 'node:path';
import { runOwnedFixture } from '../helpers/owned-fixture.js';

it('Kimi Read file paths reach capture and context lookup', async () => {
  await runOwnedFixture('tests/fixtures/worker/kimi-read-file-path-cases.ts', {
    prefix: 'owned-kimi-read-',
    env: dataDir => ({ KIMI_CODE_HOME: join(dataDir, 'kimi') }),
  });
}, 10000);
