import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getEventHandler } from '../../../src/cli/handlers/index.js';
import { observationHandler } from '../../../src/cli/handlers/observation.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

// Codex sends the root's session_id on every thread of an agent tree; a
// subagent thread is told apart by agent_id (its own thread id).
const ROOT_SESSION = '019a0000-0000-7000-8000-000000000001';
const SUBAGENT = '019a0000-0000-7000-8000-000000000002';

function codexCompaction(agentId?: string): NormalizedHookInput {
  return {
    sessionId: ROOT_SESSION,
    cwd: process.cwd(),
    platform: 'codex',
    ...(agentId ? { agentId, agentType: 'worker' } : {}),
  };
}

function codexToolCall(agentId?: string): NormalizedHookInput {
  return {
    ...codexCompaction(agentId),
    toolName: 'exec_command',
    toolInput: { cmd: 'ls' },
    toolResponse: 'README.md',
  };
}

function useIsolatedDataDir(): void {
  let dataDir: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  beforeEach(() => {
    // hermetic gate markers: never touch the real ~/.claude-mem state dir
    dataDir = mkdtempSync(join(tmpdir(), 'codex-compaction-reinjection-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
}

describe('Codex PostCompact', () => {
  useIsolatedDataDir();

  it('answers with output Codex accepts: its PostCompact schema allows no additionalContext', async () => {
    const result = await getEventHandler('post-compact').execute(codexCompaction(SUBAGENT));
    expect(codexAdapter.formatOutput(result)).toEqual({ continue: true });
  });
});

describe('Codex PostToolUse after a compaction', () => {
  useIsolatedDataDir();

  const observationResult = { continue: true, suppressOutput: true } as const;
  let observationSpy: ReturnType<typeof spyOn>;
  let contextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    observationSpy = spyOn(observationHandler, 'execute').mockImplementation(async () => ({ ...observationResult }));
    contextSpy = spyOn(contextHandler, 'execute').mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory timeline' },
    }));
  });

  afterEach(() => {
    observationSpy.mockRestore();
    contextSpy.mockRestore();
  });

  it('records the tool call and returns the timeline to the subagent thread that compacted, once', async () => {
    await getEventHandler('post-compact').execute(codexCompaction(SUBAGENT));
    const postToolUse = getEventHandler('observation');

    const first = await postToolUse.execute(codexToolCall(SUBAGENT));
    expect(observationSpy).toHaveBeenCalledTimes(1);
    expect(codexAdapter.formatOutput(first)).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'memory timeline' },
    });

    const second = await postToolUse.execute(codexToolCall(SUBAGENT));
    expect(observationSpy).toHaveBeenCalledTimes(2);
    expect(second).toEqual(observationResult);
    expect(contextSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves tool calls alone on a thread that has not compacted', async () => {
    const result = await getEventHandler('observation').execute(codexToolCall(SUBAGENT));

    expect(result).toEqual(observationResult);
    expect(contextSpy).not.toHaveBeenCalled();
  });

  it('re-injects only into the thread that compacted, though the tree shares one session id', async () => {
    await getEventHandler('post-compact').execute(codexCompaction(SUBAGENT));
    const postToolUse = getEventHandler('observation');

    expect(await postToolUse.execute(codexToolCall())).toEqual(observationResult);
    expect(contextSpy).not.toHaveBeenCalled();

    const subagentResult = await postToolUse.execute(codexToolCall(SUBAGENT));
    expect(subagentResult.hookSpecificOutput?.additionalContext).toBe('memory timeline');
  });

  it('keeps the plain tool-call result when the timeline comes back empty', async () => {
    contextSpy.mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
    }));
    await getEventHandler('post-compact').execute(codexCompaction(SUBAGENT));

    const result = await getEventHandler('observation').execute(codexToolCall(SUBAGENT));

    expect(result).toEqual(observationResult);
  });

  it('passes the worker-outage notice along with the timeline', async () => {
    contextSpy.mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'memory instructions' },
      systemMessage: 'claude-mem worker is unavailable',
    }));
    await getEventHandler('post-compact').execute(codexCompaction(SUBAGENT));

    const result = await getEventHandler('observation').execute(codexToolCall(SUBAGENT));

    expect(codexAdapter.formatOutput(result)).toEqual({
      continue: true,
      systemMessage: 'claude-mem worker is unavailable',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'memory instructions' },
    });
  });

  it('still passes the worker-outage notice on when there is no timeline to return', async () => {
    // Memory instructions off and the worker down: the context hook has already
    // marked the session's one outage notice as shown, so dropping it loses it.
    contextSpy.mockImplementation(async () => ({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
      systemMessage: 'claude-mem worker is unavailable',
    }));
    await getEventHandler('post-compact').execute(codexCompaction(SUBAGENT));

    const result = await getEventHandler('observation').execute(codexToolCall(SUBAGENT));

    expect(codexAdapter.formatOutput(result)).toEqual({
      continue: true,
      systemMessage: 'claude-mem worker is unavailable',
    });
  });

  it('only re-injects on Codex', async () => {
    await getEventHandler('post-compact').execute(codexCompaction());

    const otherPlatform = await getEventHandler('observation').execute({ ...codexToolCall(), platform: 'claude-code' });

    expect(otherPlatform).toEqual(observationResult);
    expect(contextSpy).not.toHaveBeenCalled();
  });
});

describe('Codex SessionStart after a compaction', () => {
  useIsolatedDataDir();

  const originalInternalFlag = process.env.CLAUDE_MEM_INTERNAL;
  afterEach(() => {
    if (originalInternalFlag === undefined) delete process.env.CLAUDE_MEM_INTERNAL;
    else process.env.CLAUDE_MEM_INTERNAL = originalInternalFlag;
  });

  it('answers the root thread compaction, so its next tool call does not repeat the timeline', async () => {
    // Untracked cwd: the real context handler returns before any worker call.
    process.env.CLAUDE_MEM_INTERNAL = '1';
    const observationSpy = spyOn(observationHandler, 'execute').mockImplementation(async () => ({ continue: true }));

    try {
      await getEventHandler('post-compact').execute(codexCompaction());
      await getEventHandler('context').execute(codexCompaction());
      const contextSpy = spyOn(contextHandler, 'execute');

      try {
        await getEventHandler('observation').execute(codexToolCall());
        expect(contextSpy).not.toHaveBeenCalled();
      } finally {
        contextSpy.mockRestore();
      }
    } finally {
      observationSpy.mockRestore();
    }
  });
});
