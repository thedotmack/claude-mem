import { it } from 'bun:test';
import { runOwnedFixture } from '../helpers/owned-fixture.js';

it('preserves Gemini pacing through compression deadlines', async () => {
  await runOwnedFixture('tests/fixtures/gemini/pacing-compression-cases.ts', { prefix: 'owned-gemini-pacing-' });
}, 10000);
