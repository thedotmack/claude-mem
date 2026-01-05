import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock logger BEFORE imports (required pattern)
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// Import after mocks
import { replaceTaggedContent, formatTimelineForClaudeMd } from '../../src/utils/claude-md-utils.js';

afterEach(() => {
  mock.restore();
});

describe('replaceTaggedContent', () => {
  it('should wrap new content in tags when existing content is empty', () => {
    const result = replaceTaggedContent('', 'New content here');

    expect(result).toBe('<claude-mem-context>\nNew content here\n</claude-mem-context>');
  });

  it('should replace only tagged section when existing content has tags', () => {
    const existingContent = 'User content before\n<claude-mem-context>\nOld generated content\n</claude-mem-context>\nUser content after';
    const newContent = 'New generated content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('User content before\n<claude-mem-context>\nNew generated content\n</claude-mem-context>\nUser content after');
  });

  it('should append tagged content with separator when no tags exist in existing content', () => {
    const existingContent = 'User written documentation';
    const newContent = 'Generated timeline';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('User written documentation\n\n<claude-mem-context>\nGenerated timeline\n</claude-mem-context>');
  });

  it('should append when only opening tag exists (no matching end tag)', () => {
    const existingContent = 'Some content\n<claude-mem-context>\nIncomplete tag section';
    const newContent = 'New content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('Some content\n<claude-mem-context>\nIncomplete tag section\n\n<claude-mem-context>\nNew content\n</claude-mem-context>');
  });

  it('should append when only closing tag exists (no matching start tag)', () => {
    const existingContent = 'Some content\n</claude-mem-context>\nMore content';
    const newContent = 'New content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('Some content\n</claude-mem-context>\nMore content\n\n<claude-mem-context>\nNew content\n</claude-mem-context>');
  });

  it('should preserve newlines in new content', () => {
    const existingContent = '<claude-mem-context>\nOld content\n</claude-mem-context>';
    const newContent = 'Line 1\nLine 2\nLine 3';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('<claude-mem-context>\nLine 1\nLine 2\nLine 3\n</claude-mem-context>');
  });
});

describe('formatTimelineForClaudeMd', () => {
  it('should return "No recent activity" for empty input', () => {
    const result = formatTimelineForClaudeMd('');

    expect(result).toContain('# Recent Activity');
    expect(result).toContain('*No recent activity*');
  });

  it('should return "No recent activity" when no table rows exist', () => {
    const input = 'Just some plain text without table rows';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('*No recent activity*');
  });

  it('should parse single observation row correctly', () => {
    const input = '| #123 | 4:30 PM | 🔵 | User logged in | ~100 |';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('#123');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('🔵');
    expect(result).toContain('User logged in');
    expect(result).toContain('~100');
  });

  it('should parse ditto mark for repeated time correctly', () => {
    const input = `| #123 | 4:30 PM | 🔵 | First action | ~100 |
| #124 | ″ | 🔵 | Second action | ~150 |`;

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('#123');
    expect(result).toContain('#124');
    // First occurrence should show time
    expect(result).toContain('4:30 PM');
    // Second occurrence should show ditto mark
    expect(result).toContain('"');
  });

  it('should parse session ID format (#S123) correctly', () => {
    const input = '| #S123 | 4:30 PM | 🟣 | Session started | ~200 |';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('#S123');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('🟣');
    expect(result).toContain('Session started');
  });
});
