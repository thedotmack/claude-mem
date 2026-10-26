import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  antigravityCliAdapter,
  inspectAntigravityTurn,
  resolveAntigravityPreInvocation,
} from '../../src/cli/adapters/antigravity-cli.js';
import { expandHomeDirectory, extractFilePaths } from '../../src/cli/adapters/codex-file-context.js';
import {
  fileContextHandler,
  runAntigravityPreInvocation,
  sessionInitHandler,
} from '../../src/cli/handlers/index.js';
import { fileHistoryQueryPaths } from '../../src/cli/handlers/file-context.js';
import { extractObservationFileEvidence } from '../../src/services/worker/agents/ResponseProcessor.js';
import { findLastJsonlEntryBackward } from '../../src/shared/transcript-parser.js';
import type { NormalizedHookInput } from '../../src/cli/types.js';

// agy fires PreInvocation before every model call of a turn (#5078). Only the
// first call of a user turn may record a prompt; a follow-up call after a tool
// step gets file-context for the files that step read.

let root: string;
let workspace: string;
let fakeHome: string;
let absoluteFile: string;
let homeFile: string;

const userInput = (text: string) => ({ step_index: 0, source: 'USER', type: 'USER_INPUT', content: `<USER_REQUEST>${text}</USER_REQUEST>` });
// Transcript tool_calls carry string args as JSON-quoted literals.
const plannerReadingFiles = () => ({
  step_index: 1,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  content: 'Reading the files.',
  tool_calls: [
    { name: 'read_file', args: { Path: JSON.stringify(absoluteFile) } },
    { name: 'run_command', args: { CommandLine: JSON.stringify('cat ~/p/y.ts') } },
  ],
});
const toolStep = { step_index: 2, source: 'MODEL', type: 'VIEW_FILE', content: 'file body' };

function writeTranscript(name: string, nodes: object[]): string {
  const transcriptPath = join(root, name);
  writeFileSync(transcriptPath, nodes.map(node => JSON.stringify(node)).join('\n') + '\n');
  return transcriptPath;
}

function preInvocation(transcriptPath: string | undefined, prompt?: string): NormalizedHookInput {
  return {
    sessionId: 'conv-1',
    cwd: workspace,
    platform: 'antigravity-cli',
    prompt,
    toolName: 'AntigravityProvider',
    toolInput: { prompt: prompt ?? 'User Query' },
    transcriptPath,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agy-turns-'));
  workspace = join(root, 'proj');
  fakeHome = join(root, 'home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(fakeHome, 'p'), { recursive: true });
  absoluteFile = join(workspace, 'x.ts');
  homeFile = join(fakeHome, 'p', 'y.ts');
  writeFileSync(absoluteFile, 'export const x = 1;\n');
  writeFileSync(homeFile, 'export const y = 2;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('inspectAntigravityTurn', () => {
  it('reads a newest USER_INPUT as a new user turn', () => {
    const transcriptPath = writeTranscript('new-turn.jsonl', [userInput('fix the bug')]);
    expect(inspectAntigravityTurn(transcriptPath, workspace, fakeHome)).toEqual({ isNewUserTurn: true, filePaths: [] });
  });

  it('reads a newest PLANNER_RESPONSE as a follow-up and collects the files its tool calls read', () => {
    const transcriptPath = writeTranscript('follow-up.jsonl', [userInput('fix the bug'), plannerReadingFiles(), toolStep]);
    expect(inspectAntigravityTurn(transcriptPath, workspace, fakeHome)).toEqual({
      isNewUserTurn: false,
      filePaths: [absoluteFile, homeFile],
    });
  });

  it('reads a second USER_INPUT after a follow-up as a new turn again', () => {
    const transcriptPath = writeTranscript('second-turn.jsonl', [
      userInput('fix the bug'),
      plannerReadingFiles(),
      toolStep,
      userInput('now add a test'),
    ]);
    expect(inspectAntigravityTurn(transcriptPath, workspace, fakeHome).isNewUserTurn).toBe(true);
  });

  it('fails closed when the transcript is missing, unreadable or has no turn node', () => {
    expect(inspectAntigravityTurn(undefined, workspace, fakeHome).isNewUserTurn).toBe(false);
    expect(inspectAntigravityTurn(join(root, 'nope.jsonl'), workspace, fakeHome).isNewUserTurn).toBe(false);
    // A directory exists but can't be read as a file.
    expect(inspectAntigravityTurn(workspace, workspace, fakeHome).isNewUserTurn).toBe(false);
    const noTurn = writeTranscript('no-turn.jsonl', [toolStep]);
    expect(inspectAntigravityTurn(noTurn, workspace, fakeHome).isNewUserTurn).toBe(false);
  });

  it('stops the backward scan at the newest turn node instead of reading the whole file', () => {
    const nodes: object[] = [userInput('old turn')];
    for (let i = 0; i < 2_000; i++) nodes.push({ ...toolStep, step_index: i + 1, content: 'x'.repeat(200) });
    nodes.push(userInput('current turn'));
    const transcriptPath = writeTranscript('long.jsonl', nodes);
    const visited: string[] = [];
    const hit = findLastJsonlEntryBackward(transcriptPath, (node) => {
      visited.push(node.type);
      return node.type === 'USER_INPUT' ? node.content : undefined;
    }, { initialBytes: 4 * 1024 });
    expect(hit).toBe('<USER_REQUEST>current turn</USER_REQUEST>');
    expect(visited).toEqual(['USER_INPUT']);
  });
});

describe('resolveAntigravityPreInvocation', () => {
  it('keeps the prompt as submittedPrompt on a new turn', () => {
    const transcriptPath = writeTranscript('resolve-new.jsonl', [userInput('fix the bug')]);
    const resolved = resolveAntigravityPreInvocation(preInvocation(transcriptPath, 'fix the bug'), fakeHome);
    expect(resolved.submittedPrompt).toBe('fix the bug');
  });

  it('marks a follow-up call as not a user turn and hands file-context the files read', () => {
    const transcriptPath = writeTranscript('resolve-follow.jsonl', [userInput('fix the bug'), plannerReadingFiles()]);
    const resolved = resolveAntigravityPreInvocation(preInvocation(transcriptPath, 'fix the bug'), fakeHome);
    expect(resolved.submittedPrompt).toBeNull();
    expect(resolved.toolInput).toEqual({ prompt: 'fix the bug', filePaths: [absoluteFile, homeFile] });
  });

  it('records no prompt when the transcript is missing', () => {
    const resolved = resolveAntigravityPreInvocation(preInvocation(join(root, 'gone.jsonl'), 'fix the bug'), fakeHome);
    expect(resolved.submittedPrompt).toBeNull();
  });
});

describe('runAntigravityPreInvocation dispatch', () => {
  const done = { continue: true, suppressOutput: true };
  let sessionInitSpy: ReturnType<typeof spyOn>;
  let fileContextSpy: ReturnType<typeof spyOn>;

  function spyOnHandlers() {
    sessionInitSpy = spyOn(sessionInitHandler, 'execute').mockImplementation(async () => done);
    fileContextSpy = spyOn(fileContextHandler, 'execute').mockImplementation(async () => done);
  }

  afterEach(() => {
    sessionInitSpy?.mockRestore();
    fileContextSpy?.mockRestore();
  });

  it('sends the first call of a turn to session-init with the prompt', async () => {
    spyOnHandlers();
    const transcriptPath = writeTranscript('dispatch-new.jsonl', [userInput('fix the bug')]);
    await runAntigravityPreInvocation(preInvocation(transcriptPath, 'fix the bug'));
    expect(sessionInitSpy).toHaveBeenCalledTimes(1);
    expect((sessionInitSpy.mock.calls[0][0] as NormalizedHookInput).submittedPrompt).toBe('fix the bug');
    expect(fileContextSpy).not.toHaveBeenCalled();
  });

  it('sends a follow-up call that read files to file-context, never session-init', async () => {
    spyOnHandlers();
    const transcriptPath = writeTranscript('dispatch-follow.jsonl', [userInput('fix the bug'), plannerReadingFiles()]);
    await runAntigravityPreInvocation(preInvocation(transcriptPath, 'fix the bug'));
    expect(sessionInitSpy).not.toHaveBeenCalled();
    expect(fileContextSpy).toHaveBeenCalledTimes(1);
    const toolInput = (fileContextSpy.mock.calls[0][0] as NormalizedHookInput).toolInput as { filePaths: string[] };
    expect(toolInput.filePaths).toContain(absoluteFile);
  });

  it('does nothing for a missing transcript: no prompt row, no lookup', async () => {
    spyOnHandlers();
    const result = await runAntigravityPreInvocation(preInvocation(join(root, 'gone.jsonl'), 'fix the bug'));
    expect(sessionInitSpy).not.toHaveBeenCalled();
    expect(fileContextSpy).not.toHaveBeenCalled();
    expect(result.continue).toBe(true);
  });
});

describe('home-directory paths (#5078)', () => {
  it('expands ~/ in a read command before checking the file exists', () => {
    expect(expandHomeDirectory('~/p/y.ts', fakeHome)).toBe(homeFile);
    expect(expandHomeDirectory('src/a.ts', fakeHome)).toBe('src/a.ts');
    // Shared with Codex: `cat ~/p/y.ts` used to resolve to <cwd>/~/p/y.ts.
    expect(extractFilePaths('Bash', { command: 'cat ~/p/y.ts' }, workspace, fakeHome)).toEqual([homeFile]);
  });

  it('queries file history by the ~/ form too for a file under the home directory', () => {
    expect(fileHistoryQueryPaths('/home/u/p/y.ts', '../../home/u/p/y.ts', '/home/u')).toEqual([
      '/home/u/p/y.ts',
      '../../home/u/p/y.ts',
      '~/p/y.ts',
    ]);
    expect(fileHistoryQueryPaths('/srv/p/y.ts', 'p/y.ts', '/home/u')).toEqual(['/srv/p/y.ts', 'p/y.ts']);
  });
});

describe('observation file evidence for agy tools', () => {
  // The worker sees the tool input as the adapter normalized it on PostToolUse.
  const postToolUse = (name: string, args: Record<string, unknown>) => {
    const normalized = antigravityCliAdapter.normalizeInput({
      workspacePaths: [workspace],
      conversationId: 'conv-1',
      toolCall: { name, args },
    });
    return { type: 'observation' as const, tool_name: normalized.toolName, tool_input: normalized.toolInput };
  };

  it('records read_file/view_file Path as reads and edit_file path as a write', () => {
    const evidence = extractObservationFileEvidence([
      postToolUse('read_file', { Path: '/abs/a.ts' }),
      postToolUse('view_file', { Path: JSON.stringify('/abs/b.ts') }),
      postToolUse('edit_file', { path: '/abs/c.ts' }),
    ]);
    expect(evidence.files_read).toEqual(['/abs/a.ts', '/abs/b.ts']);
    expect(evidence.files_modified).toEqual(['/abs/c.ts']);
  });
});
