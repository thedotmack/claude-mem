import { it } from 'bun:test';
import { runOwnedFixture } from '../helpers/owned-fixture.js';

it('spaces concurrent Gemini sessions with normal and stalled timers', async () => {
  await runOwnedFixture('tests/fixtures/gemini/concurrent-pacing-cases.ts', { prefix: 'owned-gemini-pacing-' });
}, 10000);
