import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import * as workerUtils from '../../src/shared/worker-utils.js';

const roots: string[] = [];
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
afterEach(async () => {
  await settleHookSpoolNudges();
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('standalone transcript observation transport', () => {
  it('hands tool results to the worker live without an in-process worker context or disk spool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-transcript-standalone-'));
    roots.push(root);
    process.env.CLAUDE_MEM_DATA_DIR = root;
    const schema: TranscriptSchema = {
      name: 'transport',
      sessionIdPath: 'session',
      events: [{ name: 'observation', action: 'observation', fields: {
        toolName: 'name', toolInput: 'input', toolResponse: 'output', toolUseId: 'id',
      } }],
    };
    const handoffs: { path: string; body: any }[] = [];
    const request = spyOn(workerUtils, 'workerHttpRequest').mockImplementation(async (path: string, init: any = {}) => {
      handoffs.push({ path, body: JSON.parse(init.body) });
      return new Response('{}');
    });
    try {
      const processor = new TranscriptEventProcessor('spool');
      await processor.processEntry({ session: 's', name: 'Read', input: { path: 'a' }, output: 'contents', id: 'local-1' }, {
        name: 'grok-bot', path: '/unused', workspace: '/repo', agentId: 'agent-1', schema,
      }, schema);
      await settleHookSpoolNudges();
      expect(handoffs.map(h => h.path)).toEqual(['/api/sessions/observations']);
      expect(handoffs[0].body).toMatchObject({ contentSessionId: 's', platformSource: 'grok-bot', cwd: '/repo', tool_name: 'Read', tool_input: { path: 'a' }, tool_response: 'contents', toolUseId: 'local-1', agentId: 'agent-1' });
      const spooled: unknown[] = [];
      await new HookSpool().drain(entry => { spooled.push(entry); return true; });
      expect(spooled).toEqual([]);
    } finally { request.mockRestore(); }
  });
});
