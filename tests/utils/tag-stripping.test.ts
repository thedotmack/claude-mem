/**
 * Tag Stripping Utility Tests
 *
 * Tests the dual-tag privacy system for <private> and <claude-mem-context> tags.
 * These tags enable users and the system to exclude content from memory storage.
 *
 * Sources:
 * - Implementation from src/utils/tag-stripping.ts
 * - Privacy patterns from src/services/worker/http/routes/SessionRoutes.ts
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { stripMemoryTagsFromPrompt, stripMemoryTagsFromJson } from '../../src/utils/tag-stripping.js';
import { logger } from '../../src/utils/logger.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Tag Stripping Utilities', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  describe('stripMemoryTagsFromPrompt', () => {
    describe('basic tag removal', () => {
      it('should strip single <private> tag and preserve surrounding content', () => {
        const input = 'public content <private>secret stuff</private> more public';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('public content  more public');
      });

      it('should strip single <claude-mem-context> tag', () => {
        const input = 'public content <claude-mem-context>injected context</claude-mem-context> more public';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('public content  more public');
      });

      it('should strip both tag types in mixed content', () => {
        const input = '<private>secret</private> public <claude-mem-context>context</claude-mem-context> end';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('public  end');
      });
    });

    describe('multiple tags handling', () => {
      it('should strip multiple <private> blocks', () => {
        const input = '<private>first secret</private> middle <private>second secret</private> end';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('middle  end');
      });

      it('should strip multiple <claude-mem-context> blocks', () => {
        const input = '<claude-mem-context>ctx1</claude-mem-context><claude-mem-context>ctx2</claude-mem-context> content';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('content');
      });

      it('should handle many interleaved tags', () => {
        let input = 'start';
        for (let i = 0; i < 10; i++) {
          input += ` <private>p${i}</private> <claude-mem-context>c${i}</claude-mem-context>`;
        }
        input += ' end';
        const result = stripMemoryTagsFromPrompt(input);
        // Tags are stripped but spaces between them remain
        expect(result).not.toContain('<private>');
        expect(result).not.toContain('<claude-mem-context>');
        expect(result).toContain('start');
        expect(result).toContain('end');
      });
    });

    describe('empty and private-only prompts', () => {
      it('should return empty string for entirely private prompt', () => {
        const input = '<private>entire prompt is private</private>';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('');
      });

      it('should return empty string for entirely context-tagged prompt', () => {
        const input = '<claude-mem-context>all is context</claude-mem-context>';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('');
      });

      it('should preserve content with no tags', () => {
        const input = 'no tags here at all';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('no tags here at all');
      });

      it('should handle empty input', () => {
        const result = stripMemoryTagsFromPrompt('');
        expect(result).toBe('');
      });

      it('should handle whitespace-only after stripping', () => {
        const input = '<private>content</private>   <claude-mem-context>more</claude-mem-context>';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('');
      });
    });

    describe('content preservation', () => {
      it('should preserve non-tagged content exactly', () => {
        const input = 'keep this <private>remove this</private> and this';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('keep this  and this');
      });

      it('should preserve special characters in non-tagged content', () => {
        const input = 'code: const x = 1; <private>secret</private> more: { "key": "value" }';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('code: const x = 1;  more: { "key": "value" }');
      });

      it('should preserve newlines in non-tagged content', () => {
        const input = 'line1\n<private>secret</private>\nline2';
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('line1\n\nline2');
      });
    });

    describe('multiline content in tags', () => {
      it('should strip multiline content within <private> tags', () => {
        const input = `public
<private>
multi
line
secret
</private>
end`;
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('public\n\nend');
      });

      it('should strip multiline content within <claude-mem-context> tags', () => {
        const input = `start
<claude-mem-context>
# Recent Activity
- Item 1
- Item 2
</claude-mem-context>
finish`;
        const result = stripMemoryTagsFromPrompt(input);
        expect(result).toBe('start\n\nfinish');
      });
    });

    describe('ReDoS protection', () => {
      it('should handle content with many tags without hanging (< 1 second)', async () => {
        // Generate content with many tags
        let content = '';
        for (let i = 0; i < 150; i++) {
          content += `<private>secret${i}</private> text${i} `;
        }

        const startTime = Date.now();
        const result = stripMemoryTagsFromPrompt(content);
        const duration = Date.now() - startTime;

        // Should complete quickly despite many tags
        expect(duration).toBeLessThan(1000);
        // Should not contain any private content
        expect(result).not.toContain('<private>');
        // Should warn about exceeding tag limit
        expect(loggerSpies[2]).toHaveBeenCalled(); // warn spy
      });

      it('should process within reasonable time with nested-looking patterns', () => {
        // Content that looks like it could cause backtracking
        const content = '<private>' + 'x'.repeat(10000) + '</private> keep this';

        const startTime = Date.now();
        const result = stripMemoryTagsFromPrompt(content);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(1000);
        expect(result).toBe('keep this');
      });
    });
  });

  describe('stripMemoryTagsFromJson', () => {
    describe('JSON content stripping', () => {
      it('should strip tags from stringified JSON', () => {
        const jsonContent = JSON.stringify({
          file_path: '/path/to/file',
          content: '<private>secret</private> public'
        });
        const result = stripMemoryTagsFromJson(jsonContent);
        const parsed = JSON.parse(result);
        expect(parsed.content).toBe(' public');
      });

      it('should strip claude-mem-context tags from JSON', () => {
        const jsonContent = JSON.stringify({
          data: '<claude-mem-context>injected</claude-mem-context> real data'
        });
        const result = stripMemoryTagsFromJson(jsonContent);
        const parsed = JSON.parse(result);
        expect(parsed.data).toBe(' real data');
      });

      it('should handle tool_input with tags', () => {
        const toolInput = {
          command: 'echo hello',
          args: '<private>secret args</private>'
        };
        const result = stripMemoryTagsFromJson(JSON.stringify(toolInput));
        const parsed = JSON.parse(result);
        expect(parsed.args).toBe('');
      });

      it('should handle tool_response with tags', () => {
        const toolResponse = {
          output: 'result <claude-mem-context>context data</claude-mem-context>',
          status: 'success'
        };
        const result = stripMemoryTagsFromJson(JSON.stringify(toolResponse));
        const parsed = JSON.parse(result);
        expect(parsed.output).toBe('result ');
      });
    });

    describe('edge cases', () => {
      it('should handle empty JSON object', () => {
        const result = stripMemoryTagsFromJson('{}');
        expect(result).toBe('{}');
      });

      it('should handle JSON with no tags', () => {
        const input = JSON.stringify({ key: 'value' });
        const result = stripMemoryTagsFromJson(input);
        expect(result).toBe(input);
      });

      it('should handle nested JSON structures', () => {
        const input = JSON.stringify({
          outer: {
            inner: '<private>secret</private> visible'
          }
        });
        const result = stripMemoryTagsFromJson(input);
        const parsed = JSON.parse(result);
        expect(parsed.outer.inner).toBe(' visible');
      });
    });
  });

  describe('privacy enforcement integration', () => {
    it('should allow empty result to trigger privacy skip', () => {
      // Simulates what SessionRoutes does with private-only prompts
      const prompt = '<private>entirely private prompt</private>';
      const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

      // Empty/whitespace prompts should trigger skip
      const shouldSkip = !cleanedPrompt || cleanedPrompt.trim() === '';
      expect(shouldSkip).toBe(true);
    });

    it('should allow partial content when not entirely private', () => {
      const prompt = '<private>password123</private> Please help me with my code';
      const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

      const shouldSkip = !cleanedPrompt || cleanedPrompt.trim() === '';
      expect(shouldSkip).toBe(false);
      expect(cleanedPrompt.trim()).toBe('Please help me with my code');
    });
  });
});
