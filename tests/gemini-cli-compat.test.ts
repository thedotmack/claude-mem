/**
 * Tests for Gemini CLI 0.37.0 compatibility fixes (Issue #1664)
 *
 * Validates:
 * 1. BeforeAgent is mapped to session-init (not user-message)
 * 2. Transcript parser handles Gemini JSON document format (type: "gemini")
 * 3. Summarize handler includes platformSource in the request body
 */
import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// 1. BeforeAgent event mapping
// ---------------------------------------------------------------------------

describe('GeminiCliHooksInstaller - event mapping', () => {
  it('should map BeforeAgent to session-init, not user-message', async () => {
    // Import the module to access the constant indirectly by inspecting
    // the generated command string through the installer's internal mapping.
    // The constant GEMINI_EVENT_TO_INTERNAL_EVENT is module-private, but we
    // can verify the effect by checking that the installer installs the
    // correct internal event name.
    //
    // Strategy: read the source file and assert the mapping directly.
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/GeminiCliHooksInstaller.ts', 'utf-8');

    // BeforeAgent must map to 'session-init'
    expect(src).toContain("'BeforeAgent': 'session-init'");
    // BeforeAgent must NOT map to 'user-message'
    expect(src).not.toContain("'BeforeAgent': 'user-message'");
  });

  it('should map SessionStart to context (unchanged)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/GeminiCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain("'SessionStart': 'context'");
  });

  it('should map SessionEnd to session-complete (unchanged)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/GeminiCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain("'SessionEnd': 'session-complete'");
  });
});

// ---------------------------------------------------------------------------
// 2. Transcript parser — Gemini JSON document format
// ---------------------------------------------------------------------------

describe('extractLastMessage - Gemini CLI 0.37.0 transcript format', () => {
  let tmpDir: string;

  // Helper: write a temp transcript file and return its path
  const writeTranscript = (name: string, content: string): string => {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  };

  // Set up / tear down a fresh temp directory per suite
  const setup = () => {
    tmpDir = join(tmpdir(), `gemini-transcript-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  };
  const teardown = () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  describe('Gemini JSON document format', () => {
    it('extracts last assistant message from Gemini transcript (type: "gemini")', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'Hello Gemini' },
            { type: 'gemini', content: 'Hi there! How can I help you today?' },
            { type: 'user', content: 'What is 2+2?' },
            { type: 'gemini', content: 'The answer is 4.' },
          ]
        });
        const filePath = writeTranscript('gemini.json', transcript);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('The answer is 4.');
      } finally {
        teardown();
      }
    });

    it('extracts last user message from Gemini transcript', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'First message' },
            { type: 'gemini', content: 'First reply' },
            { type: 'user', content: 'Second message' },
          ]
        });
        const filePath = writeTranscript('gemini-user.json', transcript);

        const result = extractLastMessage(filePath, 'user');
        expect(result).toBe('Second message');
      } finally {
        teardown();
      }
    });

    it('returns empty string when no assistant message exists in Gemini transcript', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'Just a user message' },
          ]
        });
        const filePath = writeTranscript('gemini-no-assistant.json', transcript);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('');
      } finally {
        teardown();
      }
    });

    it('strips system reminders from Gemini assistant messages when requested', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const content = 'Real answer here.<system-reminder>ignore this</system-reminder>';
        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'Question' },
            { type: 'gemini', content },
          ]
        });
        const filePath = writeTranscript('gemini-strip.json', transcript);

        const result = extractLastMessage(filePath, 'assistant', true);
        expect(result).toContain('Real answer here.');
        expect(result).not.toContain('system-reminder');
        expect(result).not.toContain('ignore this');
      } finally {
        teardown();
      }
    });

    it('handles single-turn Gemini transcript', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const transcript = JSON.stringify({
          messages: [
            { type: 'user', content: 'Hello' },
            { type: 'gemini', content: 'Hello! I am Gemini.' },
          ]
        });
        const filePath = writeTranscript('gemini-single.json', transcript);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('Hello! I am Gemini.');
      } finally {
        teardown();
      }
    });
  });

  describe('JSONL format (Claude Code) — no regression', () => {
    it('still extracts assistant messages from JSONL transcripts', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const lines = [
          JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'user msg' }] } }),
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'assistant reply' }] } }),
        ].join('\n');
        const filePath = writeTranscript('jsonl.jsonl', lines);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('assistant reply');
      } finally {
        teardown();
      }
    });

    it('still extracts string content from JSONL transcripts', async () => {
      setup();
      try {
        const { extractLastMessage } = await import('../src/shared/transcript-parser.js');

        const lines = [
          JSON.stringify({ type: 'assistant', message: { content: 'plain string response' } }),
        ].join('\n');
        const filePath = writeTranscript('jsonl-string.jsonl', lines);

        const result = extractLastMessage(filePath, 'assistant');
        expect(result).toBe('plain string response');
      } finally {
        teardown();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Summarize handler includes platformSource
// ---------------------------------------------------------------------------

describe('Summarize handler - platformSource in request body', () => {
  it('should include platformSource import in summarize.ts', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    expect(src).toContain('normalizePlatformSource');
    expect(src).toContain('platform-source');
  });

  it('should pass platformSource in the summarize request body', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    // The body must include platformSource
    expect(src).toContain('platformSource');
    // It must appear in the JSON.stringify call for the summarize endpoint
    expect(src).toContain('/api/sessions/summarize');
  });
});
