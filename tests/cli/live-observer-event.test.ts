import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as worker from '../../src/shared/worker-utils.js';
import * as settings from '../../src/shared/hook-settings.js';
import { logger } from '../../src/utils/logger.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { spoolHookEvent, settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';
import { parseHandoffTimeoutMs } from '../../src/cli/live-observer-event.js';

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

  it('sends each tool field and summary text once, in the shape the worker route reads', async () => {
    const post = spyOn(worker, 'workerHttpRequest').mockImplementation(async () => new Response('{}'));
    const toolResponse = 'x'.repeat(3 * 1024 * 1024);
    spoolHookEvent('observation', { contentSessionId: 's', platformSource: 'claude', toolName: 'Read',
      toolInput: { path: 'a' }, toolResponse, toolUseId: 't' });
    spoolHookEvent('summarize', { contentSessionId: 's', platformSource: 'claude', lastAssistantMessage: 'done' });
    await settleHookSpoolNudges();
    const [observation, summary] = post.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(observation).toMatchObject({ tool_name: 'Read', tool_input: { path: 'a' }, toolUseId: 't' });
    expect(observation.tool_response.length).toBe(toolResponse.length);
    expect(Object.keys(observation)).not.toContain('toolName');
    expect(Object.keys(observation)).not.toContain('toolInput');
    expect(Object.keys(observation)).not.toContain('toolResponse');
    // A 3 MiB result stays under the worker's 5mb cap instead of doubling past it.
    expect(Buffer.byteLength(String(post.mock.calls[0][1]?.body))).toBeLessThan(5 * 1024 * 1024);
    expect(summary).toMatchObject({ last_assistant_message: 'done' });
    expect(Object.keys(summary)).not.toContain('lastAssistantMessage');
  });

  it('logs skipped handoffs at WARN level', async () => {
    spyOn(worker, 'workerHttpRequest').mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    spoolHookEvent('observation', { contentSessionId: 's', platformSource: 'claude', toolName: 'Read' });
    await settleHookSpoolNudges();
    expect(warn).toHaveBeenCalledWith('HOOK', 'Live observer handoff unavailable; skipped event', { kind: 'observation' });
  });

  it('uses configured CLAUDE_MEM_HOOK_HANDOFF_TIMEOUT_MS for handoff deadline', async () => {
    const post = spyOn(worker, 'workerHttpRequest').mockImplementation(async () => new Response('{}'));
    spyOn(settings, 'loadFromFileOnce').mockReturnValue({
      CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: '',
      CLAUDE_MEM_WORKER_URL: '',
      CLAUDE_MEM_HOOK_HANDOFF_TIMEOUT_MS: '600',
    } as any);
    spoolHookEvent('observation', { contentSessionId: 's', platformSource: 'claude', toolName: 'Read' });
    await settleHookSpoolNudges();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]?.timeoutMs).toBe(600);
    expect(post.mock.calls[0][1]?.idleTimeoutMs).toBe(600);
  });

  it('falls back to 250ms when CLAUDE_MEM_HOOK_HANDOFF_TIMEOUT_MS is unconfigured or invalid', async () => {
    const post = spyOn(worker, 'workerHttpRequest').mockImplementation(async () => new Response('{}'));
    spyOn(settings, 'loadFromFileOnce').mockReturnValue({
      CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: '',
      CLAUDE_MEM_WORKER_URL: '',
      CLAUDE_MEM_HOOK_HANDOFF_TIMEOUT_MS: 'invalid',
    } as any);
    spoolHookEvent('observation', { contentSessionId: 's', platformSource: 'claude', toolName: 'Read' });
    await settleHookSpoolNudges();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]?.timeoutMs).toBe(250);
  });

  it('cuts a handoff timeout above 14000 ms to 14000, and reads only whole milliseconds', () => {
    spyOn(logger, 'warn').mockImplementation(() => {});
    // The hook waits for the handoff before exiting: no value may hold it past Claude Code's 15 s hook timeout.
    expect(parseHandoffTimeoutMs('120000')).toBe(14000);
    expect(parseHandoffTimeoutMs('14000')).toBe(14000);
    expect(parseHandoffTimeoutMs('600')).toBe(600);
    for (const value of ['250ms', '1.5', '-5', '0', '', undefined]) expect(parseHandoffTimeoutMs(value)).toBe(250);
  });
});
