import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema } from '../../src/services/transcripts/types.js';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event.js';

const roots: string[] = [];
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
afterEach(async () => {
  await settleHookSpoolNudges();
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('standalone transcript observation transport', () => {
  it('durably transfers tool results without an in-process worker context', async () => {
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
    const processor = new TranscriptEventProcessor('spool');
    await processor.processEntry({ session: 's', name: 'Read', input: { path: 'a' }, output: 'contents', id: 'local-1' }, {
      name: 'grok-bot', path: '/unused', workspace: '/repo', agentId: 'agent-1', schema,
    }, schema);
    const dir = join(root, 'state', 'hook-spool');
    const files = readdirSync(dir).filter(name => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const entry = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(entry.kind).toBe('observation');
    expect(entry.payload).toMatchObject({ contentSessionId: 's', platformSource: 'grok-bot', cwd: '/repo', toolName: 'Read', toolInput: { path: 'a' }, toolResponse: 'contents', toolUseId: 'local-1', agentId: 'agent-1' });
  });
});
