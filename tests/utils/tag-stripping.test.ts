
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { stripMemoryTags, stripMemoryTagsFromJsonStrings, isInternalProtocolPayload, isCodexInternalPrompt, isGrokBotInternalPrompt } from '../../src/utils/tag-stripping.js';
import { logger } from '../../src/utils/logger.js';

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

  describe('stripMemoryTags tag shapes', () => {
    it.each<[string, string, string]>([
      ['should strip single <private> tag and preserve surrounding content', 'public content <private>secret stuff</private> more public', 'public content  more public'],
      ['should strip single <claude-mem-context> tag', 'public content <claude-mem-context>injected context</claude-mem-context> more public', 'public content  more public'],
      ['should strip both tag types in mixed content', '<private>secret</private> public <claude-mem-context>context</claude-mem-context> end', 'public  end'],
      ['should strip <persisted-output> tags', 'public <persisted-output>large output</persisted-output> after', 'public  after'],
      ['should return empty string for entirely private prompt', '<private>entire prompt is private</private>', ''],
      ['should return empty string for entirely context-tagged prompt', '<claude-mem-context>all is context</claude-mem-context>', ''],
      ['should preserve content with no tags', 'no tags here at all', 'no tags here at all'],
      ['should handle empty input', '', ''],
      ['should handle whitespace-only after stripping', '<private>content</private>   <claude-mem-context>more</claude-mem-context>', ''],
      ['should preserve non-tagged content exactly', 'keep this <private>remove this</private> and this', 'keep this  and this'],
      ['should preserve special characters in non-tagged content', 'code: const x = 1; <private>secret</private> more: { "key": "value" }', 'code: const x = 1;  more: { "key": "value" }'],
      ['should preserve newlines in non-tagged content', 'line1\n<private>secret</private>\nline2', 'line1\n\nline2'],
      ['should strip multiline content within <private> tags', 'public\n<private>\nmulti\nline\nsecret\n</private>\nend', 'public\n\nend'],
      ['should strip multiline content within <claude-mem-context> tags', 'start\n<claude-mem-context>\n# Recent Activity\n- Item 1\n- Item 2\n</claude-mem-context>\nfinish', 'start\n\nfinish'],
      ['should strip tags from stringified JSON', '{"file_path":"/path/to/file","content":"<private>secret</private> public"}', '{"file_path":"/path/to/file","content":" public"}'],
      ['should strip claude-mem-context tags from JSON', '{"data":"<claude-mem-context>injected</claude-mem-context> real data"}', '{"data":" real data"}'],
      ['should handle tool_input with tags', '{"command":"echo hello","args":"<private>secret args</private>"}', '{"command":"echo hello","args":""}'],
      ['should handle tool_response with tags', '{"output":"result <claude-mem-context>context data</claude-mem-context>","status":"success"}', '{"output":"result ","status":"success"}'],
      ['should strip persisted-output tags from JSON', '{"output":"<persisted-output>big output</persisted-output> keep"}', '{"output":" keep"}'],
      ['should handle empty JSON object', '{}', '{}'],
      ['should handle JSON with no tags', '{"key":"value"}', '{"key":"value"}'],
      ['should handle nested JSON structures', '{"outer":{"inner":"<private>secret</private> visible"}}', '{"outer":{"inner":" visible"}}'],
      ['should strip single <system_instruction> tag from prompt', 'user content <system_instruction>injected instructions</system_instruction> more content', 'user content  more content'],
      ['should strip <system_instruction> mixed with <private> tags', '<system_instruction>instructions</system_instruction> public <private>secret</private> end', 'public  end'],
      ['should return empty string for entirely <system_instruction> content', '<system_instruction>entire prompt is system instructions</system_instruction>', ''],
      ['should strip <system_instruction> tags from JSON content', '{"data":"<system_instruction>injected</system_instruction> real data"}', '{"data":" real data"}'],
      ['should strip multiline content within <system_instruction> tags', 'before\n<system_instruction>\nline one\nline two\nline three\n</system_instruction>\nafter', 'before\n\nafter'],
      ['should strip single <system-instruction> tag from prompt', 'user content <system-instruction>injected instructions</system-instruction> more content', 'user content  more content'],
      ['should strip both underscore and hyphen variants in same prompt', '<system_instruction>underscore</system_instruction> middle <system-instruction>hyphen</system-instruction> end', 'middle  end'],
      ['should strip multiline <system-instruction> content', 'before\n<system-instruction>\nline one\nline two\n</system-instruction>\nafter', 'before\n\nafter'],
      ['should strip single <system-reminder> tag from prompt', 'user content <system-reminder>CLAUDE.md contents here</system-reminder> more content', 'user content  more content'],
      ['should strip <system-reminder> mixed with other tag types', '<system-reminder>reminder</system-reminder> public <private>secret</private> <claude-mem-context>ctx</claude-mem-context> end', 'public   end'],
      ['should return empty string for entirely <system-reminder> content', '<system-reminder>entire content is a system reminder</system-reminder>', ''],
      ['should strip <system-reminder> tags from JSON content', '{"data":"<system-reminder>injected reminder</system-reminder> real data"}', '{"data":" real data"}'],
      ['should strip multiline content within <system-reminder> tags', 'before\n<system-reminder>\nContents of /path/to/CLAUDE.md:\n\n<claude-mem-context>\n# Recent Activity\n- Item 1\n</claude-mem-context>\n</system-reminder>\nafter', 'before\n\nafter'],
      ['should strip realistic tool result with nested CLAUDE.md content', 'Here is the file content.\n\n<system-reminder>\nContents of /project/src/CLAUDE.md:\n\n<claude-mem-context>\n# Recent Activity\n\n### Dec 14, 2025\n| ID | Time | Title |\n|-----|------|-------|\n| #123 | 11:30 PM | Some observation |\n</claude-mem-context>\n</system-reminder>', 'Here is the file content.'],
    ])('%s', (_name, input, expected) => {
      expect(stripMemoryTags(input)).toBe(expected);
    });
  });

  describe('stripMemoryTags on prompts', () => {
    describe('multiple tags handling', () => {
      it('should strip multiple <private> blocks', () => {
        const input = '<private>first secret</private> middle <private>second secret</private> end';
        const result = stripMemoryTags(input);
        expect(result).toBe('middle  end');
      });

      it('should strip multiple <claude-mem-context> blocks', () => {
        const input = '<claude-mem-context>ctx1</claude-mem-context><claude-mem-context>ctx2</claude-mem-context> content';
        const result = stripMemoryTags(input);
        expect(result).toBe('content');
      });

      it('should handle many interleaved tags', () => {
        let input = 'start';
        for (let i = 0; i < 10; i++) {
          input += ` <private>p${i}</private> <claude-mem-context>c${i}</claude-mem-context>`;
        }
        input += ' end';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('<private>');
        expect(result).not.toContain('<claude-mem-context>');
        expect(result).toContain('start');
        expect(result).toContain('end');
      });
    });

    describe('nested and overlapping memory tags', () => {
      it('should strip a same-name tag nested inside itself', () => {
        const input = '<private>outer<private>inner</private>TAIL_SECRET</private>';
        const result = stripMemoryTags(input);
        expect(result).toBe('');
      });

      it('should strip a nested same-name tag and preserve the surrounding public text', () => {
        const input = 'before <private>outer<private>inner</private>secret tail</private> after';
        const result = stripMemoryTags(input);
        expect(result).toBe('before  after');
      });

      it('should strip nested <claude-mem-context> tags', () => {
        const input = '<claude-mem-context>a<claude-mem-context>b</claude-mem-context>LEAK</claude-mem-context>';
        const result = stripMemoryTags(input);
        expect(result).toBe('');
      });

      it('should strip a tag nested three levels deep', () => {
        const input = '<private>1<private>2<private>3</private>tail3</private>tail2</private>';
        const result = stripMemoryTags(input);
        expect(result).toBe('');
      });

      it('should strip a memory tag nested inside a different memory tag', () => {
        const input = '<system-reminder>keep<claude-mem-context>drop</claude-mem-context>TAIL</system-reminder>';
        const result = stripMemoryTags(input);
        expect(result).toBe('');
      });

      it('should keep text between two balanced nested blocks', () => {
        const input = '<private>a<private>b</private>c</private> KEEP <private>d</private>';
        const result = stripMemoryTags(input);
        expect(result).toBe('KEEP');
      });

      it('should strip a mis-nested block rather than letting tag order preserve private content', () => {
        const input = '<private>a<claude-mem-context>b</private>c</claude-mem-context>';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('<private>');
        expect(result).not.toContain('b');
      });

      it('should strip a memory tag whose attribute contains a less-than sign', () => {
        const input = '<private note="<">SECRET</private>';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('');
      });

      it('should strip a memory tag whose attribute contains angle brackets', () => {
        const input = 'keep <private data-x="a<b>c">SECRET</private> end';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('keep  end');
      });

      it('should strip a memory tag whose attribute contains closing-tag text', () => {
        const input = '<private note="</private>">SECRET</private>';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('');
      });

      it('should strip a completed inner block when an outer opener is never terminated', () => {
        const input = '<claude-mem-context prose <private>SECRET</private>';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('<claude-mem-context prose');
      });

      it('should strip a private block nested inside an unfinished outer attribute', () => {
        const input = '<claude-mem-context note="<private>SECRET</private>">';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('<claude-mem-context note="">');
      });

      it('should strip a private block after an unquoted apostrophe in an attribute', () => {
        const input = "<private note=don't>SECRET</private> public ' >";
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe("public ' >");
      });

      it('should strip the outer tail when a same-name opener is left unclosed before a completed one', () => {
        const input = '<private>SECRET1<private>SECRET2</private>';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('');
      });

      it('should leave an unclosed tag untouched so ordinary prose mentioning the tag is not swallowed', () => {
        const input = 'Explain how <private> works in this project';
        const result = stripMemoryTags(input);
        expect(result).toBe('Explain how <private> works in this project');
      });

      it('should strip a completed inner block even when the outer memory tag is unfinished', () => {
        const input = '<claude-mem-context>prose<private>SECRET</private>';
        const result = stripMemoryTags(input);
        expect(result).not.toContain('SECRET');
        expect(result).toBe('<claude-mem-context>prose');
      });
    });

    describe('ReDoS protection', () => {
      it('should handle content with many tags without hanging (< 1 second)', async () => {
        let content = '';
        for (let i = 0; i < 150; i++) {
          content += `<private>secret${i}</private> text${i} `;
        }

        const startTime = Date.now();
        const result = stripMemoryTags(content);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(1000);
        expect(result).not.toContain('<private>');
        expect(loggerSpies[2]).toHaveBeenCalled(); 
      });

      it('should process within reasonable time with nested-looking patterns', () => {
        const content = '<private>' + 'x'.repeat(10000) + '</private> keep this';

        const startTime = Date.now();
        const result = stripMemoryTags(content);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(1000);
        expect(result).toBe('keep this');
      });

      it('should stay linear on many unclosed opens and non-matching close tags', () => {
        // Adversarial input for the depth scanner: unbalanced opens plus close
        // tags that match nothing, repeated enough that a stack scan per close
        // tag would be quadratic.
        const content = '<private>'.repeat(20000) + '</nope>'.repeat(20000) + ' tail';

        const startTime = Date.now();
        const result = stripMemoryTags(content);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(2000);
        expect(result).toContain('tail');
      });

      it('should stay linear on repeated non-memory open tags with no closing bracket', () => {
        // `'<div '` has no `>`, so an attribute scan that runs before the name
        // check re-reads the whole suffix at every `<` and goes quadratic.
        const content = '<div '.repeat(60000) + ' tail';

        const startTime = Date.now();
        const result = stripMemoryTags(content);
        const duration = Date.now() - startTime;

        expect(duration).toBeLessThan(2000);
        expect(result).toContain('tail');
      });

      it('should stay fast on a large untagged input that contains no tag opener', () => {
        // Ordinary tool output with no `<` at all must not pay for the tag
        // scanner: no per-character lookup table, no second pass over the
        // whole string. 64 MiB is the shape Greptile measured; the bound is
        // generous so the test is about the fast path, not the machine.
        const content = 'x'.repeat(64 * 1024 * 1024);

        const startTime = Date.now();
        const result = stripMemoryTags(content);
        const duration = Date.now() - startTime;

        expect(result).toBe(content);
        expect(duration).toBeLessThan(500);
      });
    });
  });

  describe('isInternalProtocolPayload', () => {
    it('returns false for empty input', () => {
      expect(isInternalProtocolPayload('')).toBe(false);
    });

    it('returns true for a bare task-notification block', () => {
      expect(isInternalProtocolPayload('<task-notification>agent done</task-notification>')).toBe(true);
    });

    it('returns true for an empty-body task-notification block', () => {
      expect(isInternalProtocolPayload('<task-notification></task-notification>')).toBe(true);
    });

    it('returns true with surrounding whitespace', () => {
      expect(isInternalProtocolPayload('\n  <task-notification>x</task-notification>\n')).toBe(true);
    });

    it('returns true for multi-line payload', () => {
      const payload = '<task-notification>\nline1\nline2\n</task-notification>';
      expect(isInternalProtocolPayload(payload)).toBe(true);
    });

    it('returns true when tag has attributes', () => {
      expect(isInternalProtocolPayload('<task-notification data-id="42">x</task-notification>')).toBe(true);
    });

    it('returns false for partial / unclosed tag', () => {
      expect(isInternalProtocolPayload('<task-notification>oops')).toBe(false);
    });

    it('returns false when surrounded by user text', () => {
      const text = 'hi <task-notification>x</task-notification> more';
      expect(isInternalProtocolPayload(text)).toBe(false);
    });

    it('returns false for unrelated tags', () => {
      expect(isInternalProtocolPayload('<private>secret</private>')).toBe(false);
      expect(isInternalProtocolPayload('<system-reminder>hi</system-reminder>')).toBe(false);
    });

    it('returns false for over-large input', () => {
      const huge = '<task-notification>' + 'a'.repeat(300 * 1024);
      expect(isInternalProtocolPayload(huge)).toBe(false);
    });

    it('returns false for two protocol blocks separated by user text', () => {
      const text = '<task-notification>a</task-notification> hello <task-notification>b</task-notification>';
      expect(isInternalProtocolPayload(text)).toBe(false);
    });
    it('returns false for two adjacent protocol blocks (deliberate: deny-list per single block, not concatenations)', () => {
      const text = '<task-notification>a</task-notification><task-notification>b</task-notification>';
      expect(isInternalProtocolPayload(text)).toBe(false);
    });
  });

  describe('isCodexInternalPrompt', () => {
    it('returns false for empty input', () => {
      expect(isCodexInternalPrompt('')).toBe(false);
    });

    it('returns false for general user queries', () => {
      expect(isCodexInternalPrompt('How do I run a backup?')).toBe(false);
      expect(isCodexInternalPrompt('Memory Writing Agent is cool.')).toBe(false);
      expect(isCodexInternalPrompt('Tell me about the task title generator.')).toBe(false);
    });

    it('does not match a bare "## Memory Writing Agent" heading a person might write', () => {
      expect(isCodexInternalPrompt('## Memory Writing Agent\n\nYour job: consolidate')).toBe(false);
      expect(isCodexInternalPrompt('## Memory Writing Agent design notes')).toBe(false);
    });

    it('returns true for Codex-app title generation prompt', () => {
      expect(isCodexInternalPrompt('You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task.')).toBe(true);
      expect(isCodexInternalPrompt('You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a ta')).toBe(true);
      expect(isCodexInternalPrompt('   You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task')).toBe(true);
    });

    it('returns true for Memory Writing Agent consolidation system prompt', () => {
      expect(isCodexInternalPrompt('## Memory Writing Agent: Phase 2 (Consolidation)\n\nYou are a Memory Writing Agent.\n\nYour job: consolidate raw memories')).toBe(true);
    });

    it('returns true for Codex onboarding/suggestions prompt', () => {
      expect(isCodexInternalPrompt('# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project.')).toBe(true);
      expect(isCodexInternalPrompt('# Overview\r\n\r\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do')).toBe(true);
      expect(isCodexInternalPrompt(' # Overview\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do')).toBe(true);
    });

    it('returns true for the Codex-app next-message suggestion request (#4811)', () => {
      expect(isCodexInternalPrompt('This is an app-generated request for a suggested next user message. The user did not write this message.\n\nYour suggestion will appear in the user\'s empty message composer')).toBe(true);
    });

    it('returns true for the Codex memories rollout-summary consolidation prompt (#4811)', () => {
      expect(isCodexInternalPrompt('Consolidate the supplied rollout summaries into `memory_summary.md` so another\nagent understands the user, finds relevant prior work, and continues correctly.')).toBe(true);
    });

    it('does not match a person asking about suggestions or rollout summaries', () => {
      expect(isCodexInternalPrompt('This is an app-generated request? I did not expect that.')).toBe(false);
      expect(isCodexInternalPrompt('Consolidate the supplied rollout summaries please')).toBe(false);
    });
  });

  describe('isGrokBotInternalPrompt', () => {
    it('returns false for empty input', () => {
      expect(isGrokBotInternalPrompt('')).toBe(false);
    });

    it('returns false for general user queries', () => {
      expect(isGrokBotInternalPrompt('How do I run a backup?')).toBe(false);
      expect(isGrokBotInternalPrompt('Investigate why the tests fail on CI')).toBe(false);
      expect(isGrokBotInternalPrompt('Break the build into smaller modules')).toBe(false);
    });

    it('does not match a person paraphrasing a brief opening', () => {
      expect(isGrokBotInternalPrompt('Verify every candidate claim in the JSON packet below, please')).toBe(false);
      expect(isGrokBotInternalPrompt('Investigate the question in the JSON file I attached')).toBe(false);
      expect(isGrokBotInternalPrompt('Rewrite the research findings to be shorter')).toBe(false);
    });

    it('matches a brief with leading whitespace', () => {
      expect(isGrokBotInternalPrompt('  Independently verify every candidate claim in the JSON packet below')).toBe(true);
    });

    it('returns false for non-matching user queries and incomplete openings', () => {
      expect(isGrokBotInternalPrompt('Independently verify this claim? I typed it myself.')).toBe(false);
      expect(isGrokBotInternalPrompt('Please break the JSON-encoded research query for me')).toBe(false);
      expect(isGrokBotInternalPrompt('Rewrite the verified research')).toBe(false);
    });

    it('returns true for the research verification briefing', () => {
      expect(isGrokBotInternalPrompt('Independently verify every candidate claim in the JSON packet below.\n\n{"claims": []}')).toBe(true);
    });

    it('returns true for the verified findings rewrite briefing', () => {
      expect(isGrokBotInternalPrompt('   Rewrite the verified research findings into a clear answer.')).toBe(true);
    });

    it('returns true for the research question investigation briefing', () => {
      expect(isGrokBotInternalPrompt('Investigate the JSON-encoded question below.\n\n{"question": "How does this work?"}')).toBe(true);
    });

    it('returns true for the research query decomposition briefing', () => {
      expect(isGrokBotInternalPrompt('Break the JSON-encoded research query into focused research tasks.')).toBe(true);
    });
  });

  describe('stripMemoryTagsFromJsonStrings', () => {
    it('removes tagged sections from strings at any depth without mutating the input', () => {
      const input = {
        a: 'keep <private>drop-1</private>',
        list: ['<private>drop-2</private>', 'plain'],
        nested: { deep: { value: 'x<claude-mem-context>drop-3</claude-mem-context>' }, n: 3, ok: true, nil: null },
      };
      const output = stripMemoryTagsFromJsonStrings(input);
      expect(JSON.stringify(output)).not.toMatch(/drop-\d/);
      expect(output).toEqual({ a: 'keep', list: ['', 'plain'], nested: { deep: { value: 'x' }, n: 3, ok: true, nil: null } });
      expect(input.a).toBe('keep <private>drop-1</private>');
    });

    it('strips every tag form the string stripper accepts, including whitespace before the closing >', () => {
      const input = { prompt: 'a <private>secret</private > b', meta: ['<private>x</private\t>'] };
      expect(stripMemoryTagsFromJsonStrings(input)).toEqual({ prompt: stripMemoryTags(input.prompt), meta: [''] });
      expect(JSON.stringify(stripMemoryTagsFromJsonStrings(input))).not.toContain('secret');
    });

    it('leaves untagged strings byte-identical', () => {
      expect(stripMemoryTagsFromJsonStrings({ s: '\n  indented\n' })).toEqual({ s: '\n  indented\n' });
    });
  });
});
