import { expect, it } from 'bun:test';
import { existingAccountApprovalUrl, importSummary, runSyncCommand } from '../../src/npx-cli/commands/sync-setup.js';

it('opens existing device approval without a trial length, offer, or checkout', () => {
  const url = existingAccountApprovalUrl('https://cmem.ai/api/pro/trial/claim?pairing=abc&trial=30', 'abc');
  expect(url).toBe('https://cmem.ai/api/pro/trial/claim?pairing=abc');
});

it('reports exactly what the worker confirmed and keeps workspace data out of the terminal', () => {
  const data = { eligible: 5, queued: 2, confirmed: 2, failed: 1, skippedSources: 1, detectedAgents: ['Claude Code'], promptText: 'private text' };
  expect(importSummary(data)).toBe('5 eligible prompts. 2 confirmed synced, 2 queued, 1 failed. 1 sources could not be read.');
  expect(() => importSummary({ ...data, confirmed: -1 })).toThrow('incomplete import counts');
});

it('distinguishes a missing local source from an empty workspace', () => {
  const data = { eligible: 0, queued: 0, confirmed: 0, failed: 0, skippedSources: 0, detectedAgents: [] };
  expect(importSummary(data)).toContain('No supported transcript source was detected');
  expect(importSummary({ ...data, detectedAgents: ['Codex'] })).toBe('No attributable prompts in this workspace during the last 30 days.');
});

it('validates account and host options before touching the device', async () => {
  expect(await runSyncCommand(['setup', '--account', 'not-a-user-id'])).toBe(1);
  expect(await runSyncCommand(['setup', '--agent', 'unknown-agent'])).toBe(1);
  expect(await runSyncCommand(['setup', '--help'])).toBe(0);
});
