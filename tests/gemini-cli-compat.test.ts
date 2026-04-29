import { describe, it, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GeminiCliHooksInstaller - event mapping', () => {
  it('should map BeforeAgent to session-init, not user-message', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/GeminiCliHooksInstaller.ts', 'utf-8');

    expect(src).toContain("'BeforeAgent': 'session-init'");
    expect(src).not.toContain("'BeforeAgent': 'user-message'");
  });

  it('should map SessionStart to context (unchanged)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/GeminiCliHooksInstaller.ts', 'utf-8');
    expect(src).toContain("'SessionStart': 'context'");
  });

  it('should not map SessionEnd (worker self-completes; /clear must not drain queue)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/services/integrations/GeminiCliHooksInstaller.ts', 'utf-8');
    expect(src).not.toContain("'SessionEnd':");
  });
});

describe('extractLastMessage - Gemini CLI 0.37.0 transcript format', () => {
  let tmpDir: string;

  const writeTranscript = (name: string, content: string): string => {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  };

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
    expect(src).toContain('platformSource');
    expect(src).toContain('/api/sessions/summarize');
  });
});
