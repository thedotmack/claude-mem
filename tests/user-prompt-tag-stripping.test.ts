/**
 * Integration tests for user prompt tag stripping
 * Verifies that <private> and <claude-mem-context> tags are stripped
 * from user prompts before storage in the user_prompts table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { stripMemoryTagsFromPrompt } from '../dist/utils/tag-stripping.js';

// Alias for clarity in tests (this tests the prompt context version)
const stripMemoryTags = stripMemoryTagsFromPrompt;

describe('User Prompt Tag Stripping', () => {
  it('should strip <private> tags from user prompts', () => {
    const userPrompt = 'Please analyze this: <private>API_KEY=secret123</private>';
    const expected = 'Please analyze this:';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should strip <claude-mem-context> tags from user prompts', () => {
    const userPrompt = '<claude-mem-context>Past observations...</claude-mem-context> Continue working';
    const expected = 'Continue working';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle prompts with multiple <private> sections', () => {
    const userPrompt = '<private>secret1</private> public text <private>secret2</private>';
    const expected = 'public text';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle prompts that are entirely private', () => {
    const userPrompt = '<private>This entire prompt should not be stored</private>';
    const expected = '';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should preserve prompts without tags', () => {
    const userPrompt = 'This is a normal prompt without any tags';
    const expected = 'This is a normal prompt without any tags';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle multiline private content in prompts', () => {
    const userPrompt = `Before
<private>
Line 1 of secret
Line 2 of secret
Line 3 of secret
</private>
After`;
    const expected = 'Before\n\nAfter';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle mixed tags in user prompts', () => {
    const userPrompt = '<claude-mem-context>Context</claude-mem-context> middle <private>private</private> end';
    const expected = 'middle  end';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle real-world example: API credentials', () => {
    const userPrompt = `<private>
OPENAI_API_KEY=sk-proj-abc123
DATABASE_URL=postgresql://user:pass@host/db
</private>

Please help me connect to this database and run a query`;

    const result = stripMemoryTags(userPrompt);
    assert.ok(!result.includes('OPENAI_API_KEY'), 'API key should be stripped');
    assert.ok(!result.includes('DATABASE_URL'), 'Database URL should be stripped');
    assert.ok(!result.includes('<private>'), 'Private tags should be stripped');
    assert.ok(result.includes('Please help me connect'), 'Non-private content should remain');
  });

  it('should handle real-world example: debugging context', () => {
    const userPrompt = `I'm getting an error in the authentication flow.

<private>
Internal debugging notes:
- This is for the Smith project
- Deadline is tomorrow
- Using staging environment
</private>

Can you help me fix the token validation?`;

    const result = stripMemoryTags(userPrompt);
    assert.ok(!result.includes('Smith project'), 'Debug notes should be stripped');
    assert.ok(!result.includes('Deadline'), 'Private context should be stripped');
    assert.ok(result.includes('authentication flow'), 'Problem description should remain');
    assert.ok(result.includes('token validation'), 'Question should remain');
  });

  it('should handle edge case: only whitespace after tag removal', () => {
    const userPrompt = '  <private>everything</private>  ';
    const expected = '';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle edge case: unclosed tags (no stripping)', () => {
    const userPrompt = 'Text <private>unclosed tag';
    const expected = 'Text <private>unclosed tag';
    assert.strictEqual(stripMemoryTags(userPrompt), expected);
  });

  it('should handle non-string input gracefully', () => {
    // @ts-expect-error Testing runtime type safety
    const result = stripMemoryTags(null);
    assert.strictEqual(result, '');
  });

  // Tests for fully private prompt behavior
  it('should return empty string for fully private prompts', () => {
    const fullyPrivate = '<private>Everything is private here</private>';
    const result = stripMemoryTags(fullyPrivate);
    assert.strictEqual(result, '');
  });

  it('should return empty string for multiple private sections covering entire prompt', () => {
    const fullyPrivate = '<private>Part 1</private> <private>Part 2</private> <private>Part 3</private>';
    const result = stripMemoryTags(fullyPrivate);
    assert.strictEqual(result, '');
  });

  it('should detect fully private prompts with only whitespace outside tags', () => {
    const fullyPrivate = '  <private>Content</private>  ';
    const result = stripMemoryTags(fullyPrivate);
    assert.strictEqual(result, '');
  });

  it('should not return empty for partially private prompts', () => {
    const partiallyPrivate = '<private>Secret</private> Public content here';
    const result = stripMemoryTags(partiallyPrivate);
    assert.ok(result.trim().length > 0, 'Should have non-empty content');
    assert.ok(result.includes('Public'), 'Should contain public content');
  });
});
