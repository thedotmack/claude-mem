import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanSource, dryRunSource, ingestSource, type IngestProcessor } from '../../src/services/transcripts/ingest.js';
import type { WatchTarget, TranscriptSchema } from '../../src/services/transcripts/types.js';

// #2690 backfill: scan enumerates parents + subagents, dry-run counts what a
// real ingest would produce with zero Haiku spend.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('ingest scan + dry-run', () => {
  let root: string;
  const parentId = '11111111-1111-1111-1111-111111111111';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-ingest-'));

    // Parent session: 1 prompt, 1 assistant text + 2 tool_use, 2 tool_result.
    writeFileSync(
      join(root, `${parentId}.jsonl`),
      [
        line({ type: 'permission-mode', permissionMode: 'default' }),
        line({ type: 'user', sessionId: parentId, cwd: '/repo', message: { content: 'do the thing' } }),
        line({
          type: 'assistant',
          sessionId: parentId,
          message: {
            content: [
              { type: 'text', text: 'on it' },
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
              { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        }),
        line({
          type: 'user',
          sessionId: parentId,
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'aaa' },
              { type: 'tool_result', tool_use_id: 't2', content: 'bbb' },
            ],
          },
        }),
        'this is not json',
      ].join('\n') + '\n'
    );

    // Subagent for the parent: 1 tool_use.
    const subDir = join(root, parentId, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-aaa.jsonl'),
      line({
        type: 'assistant',
        sessionId: parentId,
        message: { content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'x' } }] },
      }) + '\n'
    );
    writeFileSync(join(subDir, 'agent-aaa.meta.json'), line({ agentType: 'general-purpose', description: 'sub work' }));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('scan finds the parent and excludes subagents by default', () => {
    const refs = scanSource(root);
    expect(refs).toHaveLength(1);
    expect(refs[0].sessionId).toBe(parentId);
    expect(refs[0].subagents).toHaveLength(0);
  });

  it('scan includes subagents (with meta) when requested', () => {
    const refs = scanSource(root, { includeSubagents: true });
    expect(refs[0].subagents).toHaveLength(1);
    expect(refs[0].subagents[0]).toMatchObject({
      sessionId: 'agent-aaa',
      agentType: 'general-purpose',
      description: 'sub work',
    });
  });

  it('dry-run counts blocks and estimates Haiku calls (parent only)', () => {
    const report = dryRunSource(root);
    expect(report.totals.sessions).toBe(1);
    const s = report.sessions[0];
    expect(s.userPrompts).toBe(1);
    expect(s.assistantTexts).toBe(1);
    expect(s.toolUses).toBe(2);
    expect(s.toolResults).toBe(2);
    expect(s.parseFailures).toBe(1);
    // 2 observations (tool_use) + 1 summary (the session)
    expect(report.totals.estimatedObservations).toBe(2);
    expect(report.totals.estimatedSummaries).toBe(1);
    expect(report.totals.estimatedHaikuCalls).toBe(3);
  });

  it('dry-run with subagents adds the subagent session and its observation', () => {
    const report = dryRunSource(root, { includeSubagents: true });
    expect(report.totals.sessions).toBe(2);
    // parent 2 + subagent 1 = 3 observations; 2 summaries → 5 Haiku calls
    expect(report.totals.estimatedObservations).toBe(3);
    expect(report.totals.estimatedSummaries).toBe(2);
    expect(report.totals.estimatedHaikuCalls).toBe(5);
    expect(report.sessions.some(s => s.isSubagent && s.sessionId === 'agent-aaa')).toBe(true);
  });

  it('scan rejects a missing source', () => {
    expect(() => scanSource(join(root, 'nope'))).toThrow(/not found/);
  });

  // Records every processEntry call so we can assert the orchestrator's behavior
  // without a live worker.
  interface Recorded {
    entry: Record<string, unknown>;
    override: string | null | undefined;
    workspace?: string;
  }
  function fakeProcessor(): { proc: IngestProcessor; calls: Recorded[] } {
    const calls: Recorded[] = [];
    const proc: IngestProcessor = {
      async processEntry(entry: unknown, watch: WatchTarget, _schema: TranscriptSchema, override?: string | null) {
        calls.push({ entry: entry as Record<string, unknown>, override, workspace: watch.workspace });
      },
    };
    return { proc, calls };
  }

  it('ingests a new parent, forces the content_session_id, and flushes session_end', async () => {
    const { proc, calls } = fakeProcessor();
    const report = await ingestSource(root, {}, { processor: proc, sessionExists: () => false });

    expect(report.found).toBe(1);
    expect(report.ingested).toBe(1);
    expect(report.alreadyIndexed).toBe(0);
    // every call overrides to the parent UUID, and per-event sessionId is stripped
    expect(calls.every(c => c.override === parentId)).toBe(true);
    expect(calls.every(c => c.entry.sessionId === undefined)).toBe(true);
    // exactly one session_end, emitted last
    const ends = calls.filter(c => c.entry.__cc === 'session_end');
    expect(ends).toHaveLength(1);
    expect(calls[calls.length - 1].entry.__cc).toBe('session_end');
  });

  it('skips a session whose content_session_id already exists', async () => {
    const { proc, calls } = fakeProcessor();
    const report = await ingestSource(root, {}, { processor: proc, sessionExists: () => true });

    expect(report.found).toBe(1);
    expect(report.ingested).toBe(0);
    expect(report.alreadyIndexed).toBe(1);
    expect(calls).toHaveLength(0); // nothing processed for a skipped session
  });

  it('subagents inherit the parent cwd and strip their own per-line cwd', async () => {
    const { proc, calls } = fakeProcessor();
    const report = await ingestSource(root, { includeSubagents: true }, { processor: proc, sessionExists: () => false });

    expect(report.found).toBe(2);
    expect(report.ingested).toBe(2);
    const subCalls = calls.filter(c => c.override === 'agent-aaa');
    expect(subCalls.length).toBeGreaterThan(0);
    // forceCwd: the subagent's own cwd is removed so it falls back to parent (watch.workspace)
    expect(subCalls.every(c => c.entry.cwd === undefined)).toBe(true);
    expect(subCalls.every(c => c.workspace === '/repo')).toBe(true);
  });
});
