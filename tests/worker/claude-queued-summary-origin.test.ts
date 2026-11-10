import { expect, it } from 'bun:test';
import { runOwnedFixture } from '../helpers/owned-fixture.js';

it('SDK queued-summary origin preserves every capture source and stalled continuation', async () => {
  const kinds = ['next-prompt', 'older-observation', 'spooled-stop', 'legacy-queue', 'control', 'summary-stall', 'cursor-prompt'];
  const output = await runOwnedFixture('tests/fixtures/worker/queued-summary-origin-cases.ts', {
    prefix: 'queued-summary-origin-', args: kinds, timeoutMs: 8000,
  });
  for (const kind of kinds) {
    expect(output).toContain(`"kind":"${kind}"`);
  }
  expect(output).toContain('Owned summary');
}, 10000);
