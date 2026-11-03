import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as worker from '../../src/shared/worker-utils.js';
import * as settings from '../../src/shared/hook-settings.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { spoolHookEvent, settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';

let dir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.CLAUDE_MEM_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'live-observer-'));
  process.env.CLAUDE_MEM_DATA_DIR = dir;
  spyOn(worker, 'getWorkerHost').mockReturnValue('127.0.0.1');
  spyOn(settings, 'loadFromFileOnce').mockReturnValue({ CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: '', CLAUDE_MEM_WORKER_URL: '' } as any);
});
afterEach(() => {
  mock.restore();
  if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe('live observation handoff', () => {
  it('delivers observation, edit and summary without writing an inference spool', async () => {
    const post = spyOn(worker, 'workerHttpRequest').mockImplementation(async () => new Response('{}'));
    const payload = { contentSessionId: 's', platformSource: 'claude', toolName: 'Read', toolUseId: 't' };
    spoolHookEvent('observation', payload);
    spoolHookEvent('file_edit', { ...payload, toolUseId: 'e' });
    spoolHookEvent('summarize', { contentSessionId: 's', platformSource: 'claude', lastAssistantMessage: 'done' });
    await settleHookSpoolNudges();
    expect(post.mock.calls.map(call => call[0])).toEqual(['/api/sessions/observations', '/api/sessions/observations', '/api/sessions/summarize']);
    expect(new HookSpool().hasEntries()).toBe(false);
  });

  it('skips a failed handoff and never replays it when the worker returns', async () => {
    const post = spyOn(worker, 'workerHttpRequest').mockRejectedValue(new Error('ECONNREFUSED'));
    spoolHookEvent('observation', { contentSessionId: 's', platformSource: 'claude', toolName: 'Read' });
    await settleHookSpoolNudges();
    post.mockImplementation(async () => new Response('{}'));
    await settleHookSpoolNudges();
    expect(post).toHaveBeenCalledTimes(1);
    expect(new HookSpool().hasEntries()).toBe(false);
  });
});
