import { afterEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';
import { normalizeSubmittedPrompt } from '../../../src/cli/adapters/claude-code.js';

// Qwen Code fires UserPromptSubmit before every supported model invocation,
// which on the core/headless path also covers ToolResult and Hook sends. Those
// carry no user text, so the session-init hook stored the `[media prompt]`
// placeholder for each one: 122 of 141 prompt rows fake in a single reported
// session, roughly one per tool round. Qwen sends `submitted_prompt` precisely
// to make the difference, and claude-mem never read it (#4215).
describe('normalizeSubmittedPrompt', () => {
  it('reports absence when the host does not send the field', () => {
    expect(normalizeSubmittedPrompt({ prompt: 'hello' })).toBeUndefined();
  });

  it('returns the submitted text when the host sends it', () => {
    expect(normalizeSubmittedPrompt({ prompt: '', submitted_prompt: 'ok commit and push' })).toBe('ok commit and push');
  });

  it('reports "not a user turn" when the host sends the field without text', () => {
    expect(normalizeSubmittedPrompt({ prompt: '', submitted_prompt: '' })).toBeNull();
    expect(normalizeSubmittedPrompt({ prompt: '', submitted_prompt: '   ' })).toBeNull();
    expect(normalizeSubmittedPrompt({ prompt: '', submitted_prompt: null })).toBeNull();
  });

  it('reports absence for a payload that is not an object', () => {
    expect(normalizeSubmittedPrompt(undefined)).toBeUndefined();
    expect(normalizeSubmittedPrompt(null)).toBeUndefined();
  });
});

describe('sessionInitHandler host-submitted prompt', () => {
  const cwd = join(tmpdir(), 'claude-mem-qwen-session-init-test');

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

  it('stores no prompt at all when the host says the send was not user-submitted', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    const result = await sessionInitHandler.execute({
      sessionId: 'qwen-continuation-send',
      cwd,
      platform: 'claude-code',
      prompt: '',
      submittedPrompt: null,
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    // The placeholder is what flooded user_prompts; nothing is stored instead.
    expect(workerCalls).toEqual([]);
  });

  it('prefers the host-submitted text over the event prompt', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    await sessionInitHandler.execute({
      sessionId: 'qwen-real-submission',
      cwd,
      platform: 'claude-code',
      prompt: 'ok commit and push',
      submittedPrompt: 'ok commit and push',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].apiPath).toBe('/api/sessions/init');
    expect(workerCalls[0].body.prompt).toBe('ok commit and push');
  });

  it('still stores the media placeholder when the host sends no field at all', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    // An image-only submission on a host that does not distinguish (Claude
    // Code) has no text, and that case is exactly what #928 added the
    // placeholder for. It must not regress into a dropped session.
    await sessionInitHandler.execute({
      sessionId: 'image-only-submission',
      cwd,
      platform: 'claude-code',
      prompt: '',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('[media prompt]');
  });

  it('leaves an ordinary text submission untouched', async () => {
    const workerCalls: WorkerCall[] = [];
    install(workerCalls);

    await sessionInitHandler.execute({
      sessionId: 'plain-text-submission',
      cwd,
      platform: 'claude-code',
      prompt: 'please review the diff',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body.prompt).toBe('please review the diff');
  });
});
