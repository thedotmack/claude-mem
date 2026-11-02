import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

// Codex sends the root's session_id on every thread of an agent tree; a
// subagent thread is told apart by agent_id (its own thread id).
const ROOT_SESSION = '019a0000-0000-7000-8000-000000000001';
const SUBAGENT = '019a0000-0000-7000-8000-000000000002';

// Codex's SubagentStart output schema rejects any other field
// (codex-rs/hooks/schema/generated/subagent-start.command.output.schema.json).
const SUBAGENT_START_OUTPUT_FIELDS = ['continue', 'hookSpecificOutput', 'stopReason', 'suppressOutput', 'systemMessage'];
const SUBAGENT_START_SPECIFIC_FIELDS = ['additionalContext', 'hookEventName'];

let rolloutDir: string;
beforeEach(() => {
  rolloutDir = mkdtempSync(join(tmpdir(), 'codex-subagent-start-'));
});
afterEach(() => {
  rmSync(rolloutDir, { recursive: true, force: true });
});

/** A subagent rollout as Codex has written it when SubagentStart runs: its session_meta line. */
function subagentRollout(sessionMeta: Record<string, unknown>): string {
  const rolloutPath = join(rolloutDir, `rollout-${SUBAGENT}.jsonl`);
  const payload = {
    id: SUBAGENT,
    session_id: ROOT_SESSION,
    parent_thread_id: ROOT_SESSION,
    source: { subagent: { thread_spawn: { parent_thread_id: ROOT_SESSION, depth: 1 } } },
    // The real line is about 20 KB: it carries the base instructions.
    base_instructions: { text: 'x'.repeat(30_000) },
    ...sessionMeta,
  };
  writeFileSync(rolloutPath, `${JSON.stringify({ timestamp: '2026-10-13T00:00:00.000Z', type: 'session_meta', payload })}\n`);
  return rolloutPath;
}

function subagentStart(transcriptPath: string | null): NormalizedHookInput {
  return {
    ...codexAdapter.normalizeInput({
      session_id: ROOT_SESSION,
      turn_id: 'turn-1',
      transcript_path: transcriptPath,
      cwd: process.cwd(),
      hook_event_name: 'SubagentStart',
      model: 'gpt-test',
      permission_mode: 'default',
      agent_id: SUBAGENT,
      agent_type: 'worker',
    }),
    platform: 'codex',
  };
}

function expectOutputCodexAccepts(output: Record<string, unknown>): void {
  for (const field of Object.keys(output)) expect(SUBAGENT_START_OUTPUT_FIELDS).toContain(field);
  const specific = output.hookSpecificOutput as Record<string, unknown> | undefined;
  if (specific) {
    for (const field of Object.keys(specific)) expect(SUBAGENT_START_SPECIFIC_FIELDS).toContain(field);
    expect(specific.hookEventName).toBe('SubagentStart');
  }
}

describe('Codex SubagentStart', () => {
  let contextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      workStateTelemetry: 'measure',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory timeline' },
    }));
  });

  afterEach(() => {
    contextSpy.mockRestore();
  });

  it('gives a subagent that starts with an empty history the memory timeline', async () => {
    const result = await getEventHandler('subagent-context').execute(subagentStart(subagentRollout({})));

    const output = codexAdapter.formatOutput(result) as Record<string, unknown>;
    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'memory timeline' },
    });
    expectOutputCodexAccepts(output);
    expect(contextSpy).toHaveBeenCalledTimes(1);
    // hook-command measures the work-state instruction the subagent was given.
    expect(result.workStateTelemetry).toBe('measure');
  });

  it('leaves a forked subagent alone: it starts from a copy of its parent history, timeline included', async () => {
    const result = await getEventHandler('subagent-context').execute(
      subagentStart(subagentRollout({ forked_from_id: ROOT_SESSION })),
    );

    const output = codexAdapter.formatOutput(result) as Record<string, unknown>;
    expect(output).toEqual({ continue: true });
    expectOutputCodexAccepts(output);
    expect(contextSpy).not.toHaveBeenCalled();
  });

  it('gives the timeline when the rollout cannot be read, since a missing timeline costs more than a duplicate', async () => {
    const unparseableRollout = join(rolloutDir, 'unparseable.jsonl');
    writeFileSync(unparseableRollout, 'not json\n');

    for (const transcriptPath of [null, join(rolloutDir, 'missing.jsonl'), unparseableRollout]) {
      const result = await getEventHandler('subagent-context').execute(subagentStart(transcriptPath));
      expect(result.hookSpecificOutput?.additionalContext).toBe('memory timeline');
    }
    expect(contextSpy).toHaveBeenCalledTimes(3);
  });

  it('sends no context without a timeline, but still passes the worker-outage notice on', async () => {
    contextSpy.mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      systemMessage: 'claude-mem worker is unavailable',
    }));

    const result = await getEventHandler('subagent-context').execute(subagentStart(subagentRollout({})));

    const output = codexAdapter.formatOutput(result) as Record<string, unknown>;
    expect(output).toEqual({ systemMessage: 'claude-mem worker is unavailable' });
    expectOutputCodexAccepts(output);
  });
});
