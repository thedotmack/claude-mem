/**
 * Regression tests for issue #2248: Cursor IDE sessions are never summarized.
 *
 * Validates the three fixes that make Cursor sessions actually get summarized
 * end-to-end (previously they were silently skipped):
 *   A. cursor adapter derives `transcriptPath` from `cwd + conversation_id`,
 *      since Cursor does not pass a transcript path on stdin.
 *   B. `extractLastMessageFromJsonl` accepts both `{type:"assistant"}` (Claude
 *      Code) and `{role:"assistant"}` (Cursor) per-line role markers.
 *   C. `extractLastMessageFromJsonl` keeps scanning back through assistant
 *      turns when the most recent one is a pure tool_use (no text content),
 *      instead of returning an empty string and causing the summary to be
 *      skipped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, win32 } from 'path';
import { tmpdir, homedir } from 'os';
import { extractLastMessage, extractLastMessageFromJsonl } from '../../src/shared/transcript-parser.js';
import { cursorAdapter, deriveCursorTranscriptPath } from '../../src/cli/adapters/cursor.js';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'cursor-session.jsonl');

// ---------------------------------------------------------------------------
// Bug B + C: extractLastMessageFromJsonl on the cursor-session.jsonl fixture
// ---------------------------------------------------------------------------

describe('cursor-extraction: extractLastMessageFromJsonl on fixture', () => {
  const fixtureContent = readFileSync(FIXTURE_PATH, 'utf-8').trim();

  it('returns the last user text from the fixture', () => {
    expect(extractLastMessageFromJsonl(fixtureContent, 'user', false)).toBe(
      'thanks, also tell me what you found'
    );
  });

  it('returns the final assistant text (skipping tool_use-only turn)', () => {
    expect(extractLastMessageFromJsonl(fixtureContent, 'assistant', false)).toBe(
      'Here are the files: adapters, handlers, types.'
    );
  });
});

// ---------------------------------------------------------------------------
// Bug B + C: extractLastMessage with extra inline cases
// ---------------------------------------------------------------------------

describe('cursor-extraction: extractLastMessage Cursor JSONL compatibility', () => {
  const tmpDir = join(tmpdir(), `cursor-extraction-test-${Date.now()}`);
  const transcriptPath = join(tmpDir, 'transcript.jsonl');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads Cursor JSONL using {"role":"assistant"} (Bug B regression)', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: 'hello' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hi from cursor' }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('hi from cursor');
  });

  it('skips a tool-only last assistant turn and returns the previous text-bearing one (Bug C regression)', () => {
    const lines = [
      { role: 'user', message: { content: [{ type: 'text', text: 'q1' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'real answer' }] } },
      { role: 'user', message: { content: [{ type: 'text', text: 'q2' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('real answer');
  });

  it('still returns "" when no assistant turn exists at all', () => {
    const lines = [{ role: 'user', message: { content: [{ type: 'text', text: 'lonely' }] } }];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('');
  });

  it('still works for Claude Code format using {"type":"assistant"}', () => {
    const lines = [
      { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'claude code answer' }] } },
    ];
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'));

    expect(extractLastMessage(transcriptPath, 'assistant')).toBe('claude code answer');
  });
});

// ---------------------------------------------------------------------------
// Bug A: cursor adapter transcript path derivation
// ---------------------------------------------------------------------------

describe('cursor-extraction: cursorAdapter transcriptPath derivation', () => {
  const sessionId = `c0ffee${Date.now()}`;
  const projectsDir = join(homedir(), '.cursor', 'projects');
  // Workspace paths as Cursor sends them in workspace_roots, each with the
  // folder Cursor names after it under ~/.cursor/projects.
  const workspaces: Array<[string, string]> = [
    ['/Users/foo.bar/workspaces', 'Users-foo-bar-workspaces'],
    ['/home/alice/code/my_app', 'home-alice-code-my-app'],
    ['/Users/alice/Code/My App', 'Users-alice-Code-My-App'],
    ['/Users/alice/.dotfiles', 'Users-alice-dotfiles'],
    ['/c:/Users/alice/code/proj', 'c-Users-alice-code-proj'],
    [win32.join('C:/', 'Users', 'Some One', 'my-repo'), 'C-Users-Some-One-my-repo'],
  ];
  // Every workspace gets this suffix, so each case writes a projects folder
  // of its own and removes only that folder.
  const suffix = `-${sessionId}`;

  function writeTranscript(folder: string): string {
    const transcriptDir = join(projectsDir, folder + suffix, 'agent-transcripts', sessionId);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n'
    );
    return transcriptPath;
  }

  afterEach(() => {
    for (const [, folder] of workspaces) {
      rmSync(join(projectsDir, folder + suffix), { recursive: true, force: true });
    }
  });

  for (const [workspace, folder] of workspaces) {
    it(`derives transcriptPath for ${workspace} from the folder Cursor names ${folder} (Bug A regression)`, () => {
      const transcriptPath = writeTranscript(folder);
      const normalized = cursorAdapter.normalizeInput({
        workspace_roots: [workspace + suffix],
        conversation_id: sessionId,
      });

      expect(normalized.sessionId).toBe(sessionId);
      expect(normalized.transcriptPath).toBe(transcriptPath);
    });
  }

  it('returns transcriptPath: undefined when the file does not exist', () => {
    const [workspace, folder] = workspaces[0];
    rmSync(writeTranscript(folder));
    const normalized = cursorAdapter.normalizeInput({
      workspace_roots: [workspace + suffix],
      conversation_id: sessionId,
    });

    expect(normalized.sessionId).toBe(sessionId);
    expect(normalized.transcriptPath).toBeUndefined();
  });

  it('returns undefined when sessionId is missing (deriveCursorTranscriptPath direct call)', () => {
    expect(deriveCursorTranscriptPath(workspaces[0][0] + suffix, undefined)).toBeUndefined();
  });

  it('returns undefined when cwd is missing (deriveCursorTranscriptPath direct call)', () => {
    expect(deriveCursorTranscriptPath(undefined, sessionId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Greptile P1 (PR #2282): malformed JSONL lines must not crash the pipeline
// ---------------------------------------------------------------------------

describe('cursor-extraction: malformed JSONL tolerance', () => {
  it('skips truncated/malformed lines and returns the last valid match', () => {
    const validLine = JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'recovered text' }] },
    });
    const malformed = '{"role":"assistant","message":{"content":[{"type":"tex'; // truncated mid-write
    const content = [validLine, malformed].join('\n');

    expect(() => extractLastMessageFromJsonl(content, 'assistant', false)).not.toThrow();
    expect(extractLastMessageFromJsonl(content, 'assistant', false)).toBe('recovered text');
  });

  it('returns empty string when ALL lines are malformed', () => {
    const content = ['{partial', 'not even close to json', '}{'].join('\n');
    expect(extractLastMessageFromJsonl(content, 'assistant', false)).toBe('');
  });

  // CodeRabbit Major + Greptile P1 (PR #2282 follow-up): a valid JSON line
  // whose `message.content` is an unexpected type (null, number, plain
  // object) used to throw. It must now be skipped — same tolerance class as
  // truncated lines.
  it('skips a line whose message.content is null and falls back to a valid earlier line', () => {
    const valid = JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'kept' }] },
    });
    const nullContent = JSON.stringify({
      role: 'assistant',
      message: { content: null },
    });
    const content = [valid, nullContent].join('\n');

    expect(() => extractLastMessageFromJsonl(content, 'assistant', false)).not.toThrow();
    expect(extractLastMessageFromJsonl(content, 'assistant', false)).toBe('kept');
  });

  it('skips a line whose message.content is a number without throwing', () => {
    const valid = JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'kept too' }] },
    });
    const numericContent = JSON.stringify({
      role: 'assistant',
      message: { content: 42 },
    });
    const content = [valid, numericContent].join('\n');

    expect(() => extractLastMessageFromJsonl(content, 'assistant', false)).not.toThrow();
    expect(extractLastMessageFromJsonl(content, 'assistant', false)).toBe('kept too');
  });

  it('skips a line whose message.content is a plain object without throwing', () => {
    const valid = JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'survivor' }] },
    });
    const objectContent = JSON.stringify({
      role: 'assistant',
      message: { content: { unexpected: 'shape' } },
    });
    const content = [valid, objectContent].join('\n');

    expect(() => extractLastMessageFromJsonl(content, 'assistant', false)).not.toThrow();
    expect(extractLastMessageFromJsonl(content, 'assistant', false)).toBe('survivor');
  });
});
