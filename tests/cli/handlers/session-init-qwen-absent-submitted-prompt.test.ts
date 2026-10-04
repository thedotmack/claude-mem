import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isQwenTranscriptPath,
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';

// #4224 taught session-init to read Qwen's `submitted_prompt` and to skip the
// send when the host sends that field empty. One case is left: Qwen's docs say
// continuation and ToolResult sends leave `submitted_prompt` out entirely, so
// the field arrives absent and the handler falls back to `prompt` -- which is
// also empty, and became a `[media prompt]` row per tool round.
//
// The absence cannot be read as "not a user turn" everywhere: Qwen and Claude
// Code run the same `hook claude-code session-init` command, and on Claude Code
// an empty prompt is a real image-only submission (#928). So the skip is scoped
// to Qwen, recognised from `transcript_path` under `~/.qwen/`.
describe('isQwenTranscriptPath', () => {
  it('recognises a Qwen transcript path', () => {
    expect(isQwenTranscriptPath('/home/dot/.qwen/tmp/abc123/chats/session.json')).toBe(true);
  });

  it('recognises a Windows-style Qwen transcript path', () => {
    expect(isQwenTranscriptPath('C:\\Users\\dot\\.qwen\\tmp\\abc123\\chats\\session.json')).toBe(true);
  });

  it('is not fooled by a project directory that merely starts with .qwen', () => {
    expect(isQwenTranscriptPath('/home/dot/projects/.qwen-notes/chats/session.json')).toBe(false);
  });

  it('is false for a Claude Code transcript path or no path at all', () => {
    expect(isQwenTranscriptPath('/home/dot/.claude/projects/x/session.jsonl')).toBe(false);
    expect(isQwenTranscriptPath(undefined)).toBe(false);
    expect(isQwenTranscriptPath('')).toBe(false);
  });
});

describe('sessionInitHandler Qwen sends with no submitted_prompt field', () => {
  const cwd = join(tmpdir(), 'claude-mem-qwen-absent-field-test');
  const qwenTranscript = '/home/dot/.qwen/tmp/abc123/chats/session.json';

  interface WorkerCall { apiPath: string; method: string; body: Record<string, unknown> }

  function install(workerCalls: WorkerCall[]): void {
    setSessionInitDependenciesForTesting({
      shouldTrackProject: () => true,
      loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      isWorkerFallback: () => false,
      executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
        workerCalls.push({ apiPath, method, body: body as Record<string, unknown> });
        return { sessionDbId: 42, promptNumber: 7 };
      },
    });
  }

  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  it('stores no prompt when Qwen omits the field and the prompt is empty', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // A Qwen ToolResult send: no `submitted_prompt` key, empty `prompt`. The
    // session already exists from the turn that WAS submitted, so nothing is
    // stored. This is the case #4224 could not reach, because it only handles
    // the field being present and empty.
    const result = await sessionInitHandler.execute({
      sessionId: 'qwen-toolresult-send',
      cwd,
      platform: 'claude-code',
      prompt: '',
      transcriptPath: qwenTranscript,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCalls).toEqual([]);
  });

  it('treats a whitespace-only prompt on Qwen the same way', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    await sessionInitHandler.execute({
      sessionId: 'qwen-whitespace-send',
      cwd,
      platform: 'claude-code',
      prompt: '   ',
      transcriptPath: qwenTranscript,
    });

    expect(workerCalls).toEqual([]);
  });

  it('still stores a real Qwen submission that happens to be empty-free', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // The host-scoping must not swallow genuine user turns on Qwen: text in
    // `prompt` with the field absent is the legacy shape and still stores.
    await sessionInitHandler.execute({
      sessionId: 'qwen-real-text-send',
      cwd,
      platform: 'claude-code',
      prompt: 'please review the diff',
      transcriptPath: qwenTranscript,
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('please review the diff');
  });

  it('keeps storing the media placeholder for a Claude Code image-only turn', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // The #928 regression guard. Claude Code sends no `submitted_prompt` field
    // at all, so without host-scoping this would regress into a dropped
    // session: an empty prompt there is a real image-only submission.
    await sessionInitHandler.execute({
      sessionId: 'claude-image-only-submission',
      cwd,
      platform: 'claude-code',
      prompt: '',
      transcriptPath: '/home/dot/.claude/projects/x/session.jsonl',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });

  it('keeps storing the media placeholder when no host can be identified', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // With no transcript path there is nothing to scope the skip to, so the
    // pre-existing behaviour stands.
    await sessionInitHandler.execute({
      sessionId: 'unknown-host-empty-prompt',
      cwd,
      platform: 'claude-code',
      prompt: '',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });
});