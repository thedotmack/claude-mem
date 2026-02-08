import { describe, it, expect } from 'bun:test';
import { buildSummaryContextPrompt } from '../../src/sdk/prompts.js';
import type { SessionSummary } from '../../src/services/sqlite/summaries/types.js';

describe('buildSummaryContextPrompt', () => {
  it('should return early-session message for null summary', () => {
    const result = buildSummaryContextPrompt(null);

    expect(result).toContain('<session_context>');
    expect(result).toContain('No summary exists yet');
    expect(result).not.toContain('<summary>');
  });

  it('should return early-session message when all content fields are empty', () => {
    const emptySummary: SessionSummary = {
      request: '',
      investigated: '',
      learned: '',
      completed: '',
      next_steps: '',
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: null,
      created_at: '2026-01-01',
      created_at_epoch: 0,
    };

    const result = buildSummaryContextPrompt(emptySummary);

    expect(result).toContain('No summary exists yet');
    expect(result).not.toContain('<summary>');
  });

  it('should return early-session message when all content fields are whitespace', () => {
    const whitespaceSummary: SessionSummary = {
      request: '   ',
      investigated: '\n',
      learned: '\t',
      completed: ' ',
      next_steps: '  ',
      files_read: null,
      files_edited: null,
      notes: 'some notes',
      prompt_number: 1,
      created_at: '2026-01-01',
      created_at_epoch: 0,
    };

    const result = buildSummaryContextPrompt(whitespaceSummary);

    expect(result).toContain('No summary exists yet');
  });

  it('should return full summary context when at least one content field is populated', () => {
    const summary: SessionSummary = {
      request: 'Fix the login bug',
      investigated: 'auth service and session store',
      learned: 'Session tokens were expiring prematurely',
      completed: 'Fixed token refresh logic',
      next_steps: 'Add integration tests',
      files_read: 'src/auth.ts',
      files_edited: 'src/auth.ts',
      notes: 'May need to update docs',
      prompt_number: 3,
      created_at: '2026-01-01',
      created_at_epoch: 1000,
    };

    const result = buildSummaryContextPrompt(summary);

    expect(result).toContain('<session_context>');
    expect(result).toContain('<summary>');
    expect(result).toContain('<request>Fix the login bug</request>');
    expect(result).toContain('<investigated>auth service and session store</investigated>');
    expect(result).toContain('<learned>Session tokens were expiring prematurely</learned>');
    expect(result).toContain('<completed>Fixed token refresh logic</completed>');
    expect(result).toContain('<next_steps>Add integration tests</next_steps>');
    expect(result).toContain('<notes>May need to update docs</notes>');
    expect(result).toContain('maintain continuity');
  });

  it('should handle summary with only one populated field', () => {
    const partialSummary: SessionSummary = {
      request: 'Implement feature X',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      created_at: '2026-01-01',
      created_at_epoch: 0,
    };

    const result = buildSummaryContextPrompt(partialSummary);

    expect(result).toContain('<summary>');
    expect(result).toContain('<request>Implement feature X</request>');
    expect(result).toContain('<investigated></investigated>');
  });

  it('should render null fields as empty strings in XML', () => {
    const summary: SessionSummary = {
      request: 'test',
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: null,
      created_at: '2026-01-01',
      created_at_epoch: 0,
    };

    const result = buildSummaryContextPrompt(summary);

    expect(result).toContain('<investigated></investigated>');
    expect(result).toContain('<learned></learned>');
    expect(result).toContain('<notes></notes>');
  });
});
