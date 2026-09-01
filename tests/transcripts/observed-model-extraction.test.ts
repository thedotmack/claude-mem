import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractLastAssistantModel,
  extractLastAssistantModelFromJsonl,
  extractLastAssistantTurn,
} from '../../src/shared/transcript-parser.js';

function claudeCodeLine(type: string, message: Record<string, unknown>): string {
  return JSON.stringify({ type, message });
}

describe('extractLastAssistantModelFromJsonl', () => {
  it('returns the model of the last assistant line (Claude Code `type` form)', () => {
    const content = [
      claudeCodeLine('user', { role: 'user', content: 'hi' }),
      claudeCodeLine('assistant', { role: 'assistant', model: 'claude-old-model', content: [] }),
      claudeCodeLine('user', { role: 'user', content: 'switch' }),
      claudeCodeLine('assistant', { role: 'assistant', model: 'claude-fable-5-1', content: [] }),
    ].join('\n');

    expect(extractLastAssistantModelFromJsonl(content)).toBe('claude-fable-5-1');
  });

  it('returns the model when a Cursor `role` form carries message.model', () => {
    const content = [
      JSON.stringify({ role: 'user', message: { content: 'hi' } }),
      JSON.stringify({ role: 'assistant', message: { model: 'cursor-model-x', content: 'yo' } }),
    ].join('\n');

    expect(extractLastAssistantModelFromJsonl(content)).toBe('cursor-model-x');
  });

  it('skips user lines and malformed lines while scanning backwards', () => {
    const content = [
      claudeCodeLine('assistant', { role: 'assistant', model: 'claude-real', content: [] }),
      claudeCodeLine('user', { role: 'user', model: 'not-an-assistant-model', content: 'x' }),
      '{"type":"assistant","message":{"model":"trunc',
      '',
    ].join('\n');

    expect(extractLastAssistantModelFromJsonl(content)).toBe('claude-real');
  });

  it('returns undefined when no assistant line has a model', () => {
    const content = [
      claudeCodeLine('user', { role: 'user', content: 'hi' }),
      claudeCodeLine('assistant', { role: 'assistant', content: [] }),
      claudeCodeLine('assistant', { role: 'assistant', model: 42, content: [] }),
      claudeCodeLine('assistant', { role: 'assistant', model: '', content: [] }),
    ].join('\n');

    expect(extractLastAssistantModelFromJsonl(content)).toBeUndefined();
  });
});

describe('extractLastAssistantModel', () => {
  it('reads the transcript file and returns the last assistant model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'observed-model-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      claudeCodeLine('assistant', { role: 'assistant', model: 'claude-from-file', content: [] }) + '\n',
    );

    expect(extractLastAssistantModel(transcriptPath)).toBe('claude-from-file');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for a missing or empty path', () => {
    expect(extractLastAssistantModel('')).toBeUndefined();
    expect(extractLastAssistantModel(join(tmpdir(), 'does-not-exist-observed-model.jsonl'))).toBeUndefined();
  });
});

describe('extractLastAssistantTurn', () => {
  it('returns both the last assistant text and its model from a single file read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'observed-turn-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        claudeCodeLine('user', { role: 'user', content: 'hi' }),
        claudeCodeLine('assistant', {
          role: 'assistant',
          model: 'claude-turn-model',
          content: [{ type: 'text', text: 'Final answer' }],
        }),
      ].join('\n') + '\n',
    );

    expect(extractLastAssistantTurn(transcriptPath)).toEqual({
      text: 'Final answer',
      model: 'claude-turn-model',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips system reminders from the text when asked, still returning the model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'observed-turn-strip-'));
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      claudeCodeLine('assistant', {
        role: 'assistant',
        model: 'claude-turn-model',
        content: [{ type: 'text', text: 'Kept <system-reminder>dropped</system-reminder>' }],
      }) + '\n',
    );

    const turn = extractLastAssistantTurn(transcriptPath, true);
    expect(turn.text).toBe('Kept');
    expect(turn.model).toBe('claude-turn-model');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns { text: "" } for a missing or empty path', () => {
    expect(extractLastAssistantTurn('')).toEqual({ text: '' });
    expect(extractLastAssistantTurn(join(tmpdir(), 'does-not-exist-observed-turn.jsonl'))).toEqual({ text: '' });
  });
});
