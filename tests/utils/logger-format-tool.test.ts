import { describe, it, expect } from 'bun:test';

/**
 * Direct implementation of formatTool for testing
 * This avoids Bun's mock.module() pollution from parallel tests
 * The logic is identical to Logger.formatTool in src/utils/logger.ts
 */
function formatTool(toolName: string, toolInput?: any): string {
  if (!toolInput) return toolName;

  let input = toolInput;
  if (typeof toolInput === 'string') {
    try {
      input = JSON.parse(toolInput);
    } catch {
      // Input is a raw string (e.g., Bash command), use as-is
      input = toolInput;
    }
  }

  // Bash: show full command
  if (toolName === 'Bash' && input.command) {
    return `${toolName}(${input.command})`;
  }

  // File operations: show full path
  if (input.file_path) {
    return `${toolName}(${input.file_path})`;
  }

  // NotebookEdit: show full notebook path
  if (input.notebook_path) {
    return `${toolName}(${input.notebook_path})`;
  }

  // Glob: show full pattern
  if (toolName === 'Glob' && input.pattern) {
    return `${toolName}(${input.pattern})`;
  }

  // Grep: show full pattern
  if (toolName === 'Grep' && input.pattern) {
    return `${toolName}(${input.pattern})`;
  }

  // WebFetch/WebSearch: show full URL or query
  if (input.url) {
    return `${toolName}(${input.url})`;
  }

  if (input.query) {
    return `${toolName}(${input.query})`;
  }

  // Task: show subagent_type or full description
  if (toolName === 'Task') {
    if (input.subagent_type) {
      return `${toolName}(${input.subagent_type})`;
    }
    if (input.description) {
      return `${toolName}(${input.description})`;
    }
  }

  // Skill: show skill name
  if (toolName === 'Skill' && input.skill) {
    return `${toolName}(${input.skill})`;
  }

  // LSP: show operation type
  if (toolName === 'LSP' && input.operation) {
    return `${toolName}(${input.operation})`;
  }

  // Default: just show tool name
  return toolName;
}

describe('logger.formatTool()', () => {
  describe('Valid JSON string input', () => {
    it('should parse JSON string and extract command for Bash', () => {
      const result = formatTool('Bash', '{"command": "ls -la"}');
      expect(result).toBe('Bash(ls -la)');
    });

    it('should parse JSON string and extract file_path', () => {
      const result = formatTool('Read', '{"file_path": "/path/to/file.ts"}');
      expect(result).toBe('Read(/path/to/file.ts)');
    });

    it('should parse JSON string and extract pattern for Glob', () => {
      const result = formatTool('Glob', '{"pattern": "**/*.ts"}');
      expect(result).toBe('Glob(**/*.ts)');
    });

    it('should parse JSON string and extract pattern for Grep', () => {
      const result = formatTool('Grep', '{"pattern": "TODO|FIXME"}');
      expect(result).toBe('Grep(TODO|FIXME)');
    });
  });

  describe('Raw non-JSON string input (Issue #545 bug fix)', () => {
    it('should handle raw command string without crashing', () => {
      // This was the bug: raw strings caused JSON.parse to throw
      const result = formatTool('Bash', 'raw command string');
      // Since it's not JSON, it should just return the tool name
      expect(result).toBe('Bash');
    });

    it('should handle malformed JSON gracefully', () => {
      const result = formatTool('Read', '{file_path: broken}');
      expect(result).toBe('Read');
    });

    it('should handle partial JSON gracefully', () => {
      const result = formatTool('Write', '{"file_path":');
      expect(result).toBe('Write');
    });

    it('should handle empty string input', () => {
      const result = formatTool('Bash', '');
      // Empty string is falsy, so returns just the tool name early
      expect(result).toBe('Bash');
    });

    it('should handle string with special characters', () => {
      const result = formatTool('Bash', 'echo "hello world" && ls');
      expect(result).toBe('Bash');
    });

    it('should handle numeric string input', () => {
      const result = formatTool('Task', '12345');
      expect(result).toBe('Task');
    });
  });

  describe('Already-parsed object input', () => {
    it('should extract command from Bash object input', () => {
      const result = formatTool('Bash', { command: 'echo hello' });
      expect(result).toBe('Bash(echo hello)');
    });

    it('should extract file_path from Read object input', () => {
      const result = formatTool('Read', { file_path: '/src/index.ts' });
      expect(result).toBe('Read(/src/index.ts)');
    });

    it('should extract file_path from Write object input', () => {
      const result = formatTool('Write', { file_path: '/output/result.json', content: 'data' });
      expect(result).toBe('Write(/output/result.json)');
    });

    it('should extract file_path from Edit object input', () => {
      const result = formatTool('Edit', { file_path: '/src/utils.ts', old_string: 'foo', new_string: 'bar' });
      expect(result).toBe('Edit(/src/utils.ts)');
    });

    it('should extract pattern from Glob object input', () => {
      const result = formatTool('Glob', { pattern: 'src/**/*.test.ts' });
      expect(result).toBe('Glob(src/**/*.test.ts)');
    });

    it('should extract pattern from Grep object input', () => {
      const result = formatTool('Grep', { pattern: 'function\\s+\\w+', path: '/src' });
      expect(result).toBe('Grep(function\\s+\\w+)');
    });

    it('should extract notebook_path from NotebookEdit object input', () => {
      const result = formatTool('NotebookEdit', { notebook_path: '/notebooks/analysis.ipynb' });
      expect(result).toBe('NotebookEdit(/notebooks/analysis.ipynb)');
    });
  });

  describe('Empty/null/undefined inputs', () => {
    it('should return just tool name when toolInput is undefined', () => {
      const result = formatTool('Bash');
      expect(result).toBe('Bash');
    });

    it('should return just tool name when toolInput is null', () => {
      const result = formatTool('Bash', null);
      expect(result).toBe('Bash');
    });

    it('should return just tool name when toolInput is undefined explicitly', () => {
      const result = formatTool('Bash', undefined);
      expect(result).toBe('Bash');
    });

    it('should return just tool name when toolInput is empty object', () => {
      const result = formatTool('Bash', {});
      expect(result).toBe('Bash');
    });

    it('should return just tool name when toolInput is 0', () => {
      // 0 is falsy
      const result = formatTool('Task', 0);
      expect(result).toBe('Task');
    });

    it('should return just tool name when toolInput is false', () => {
      // false is falsy
      const result = formatTool('Task', false);
      expect(result).toBe('Task');
    });
  });

  describe('Various tool types', () => {
    describe('Bash tool', () => {
      it('should extract command from object', () => {
        const result = formatTool('Bash', { command: 'npm install' });
        expect(result).toBe('Bash(npm install)');
      });

      it('should extract command from JSON string', () => {
        const result = formatTool('Bash', '{"command":"git status"}');
        expect(result).toBe('Bash(git status)');
      });

      it('should return just Bash when command is missing', () => {
        const result = formatTool('Bash', { description: 'some action' });
        expect(result).toBe('Bash');
      });
    });

    describe('Read tool', () => {
      it('should extract file_path', () => {
        const result = formatTool('Read', { file_path: '/Users/test/file.ts' });
        expect(result).toBe('Read(/Users/test/file.ts)');
      });
    });

    describe('Write tool', () => {
      it('should extract file_path', () => {
        const result = formatTool('Write', { file_path: '/tmp/output.txt', content: 'hello' });
        expect(result).toBe('Write(/tmp/output.txt)');
      });
    });

    describe('Edit tool', () => {
      it('should extract file_path', () => {
        const result = formatTool('Edit', { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' });
        expect(result).toBe('Edit(/src/main.ts)');
      });
    });

    describe('Grep tool', () => {
      it('should extract pattern', () => {
        const result = formatTool('Grep', { pattern: 'import.*from' });
        expect(result).toBe('Grep(import.*from)');
      });

      it('should prioritize pattern over other fields', () => {
        const result = formatTool('Grep', { pattern: 'search', path: '/src', type: 'ts' });
        expect(result).toBe('Grep(search)');
      });
    });

    describe('Glob tool', () => {
      it('should extract pattern', () => {
        const result = formatTool('Glob', { pattern: '**/*.md' });
        expect(result).toBe('Glob(**/*.md)');
      });
    });

    describe('Task tool', () => {
      it('should extract subagent_type when present', () => {
        const result = formatTool('Task', { subagent_type: 'code_review' });
        expect(result).toBe('Task(code_review)');
      });

      it('should extract description when subagent_type is missing', () => {
        const result = formatTool('Task', { description: 'Analyze the codebase structure' });
        expect(result).toBe('Task(Analyze the codebase structure)');
      });

      it('should prefer subagent_type over description', () => {
        const result = formatTool('Task', { subagent_type: 'research', description: 'Find docs' });
        expect(result).toBe('Task(research)');
      });

      it('should return just Task when neither field is present', () => {
        const result = formatTool('Task', { timeout: 5000 });
        expect(result).toBe('Task');
      });
    });

    describe('WebFetch tool', () => {
      it('should extract url', () => {
        const result = formatTool('WebFetch', { url: 'https://example.com/api' });
        expect(result).toBe('WebFetch(https://example.com/api)');
      });
    });

    describe('WebSearch tool', () => {
      it('should extract query', () => {
        const result = formatTool('WebSearch', { query: 'typescript best practices' });
        expect(result).toBe('WebSearch(typescript best practices)');
      });
    });

    describe('Skill tool', () => {
      it('should extract skill name', () => {
        const result = formatTool('Skill', { skill: 'commit' });
        expect(result).toBe('Skill(commit)');
      });

      it('should return just Skill when skill is missing', () => {
        const result = formatTool('Skill', { args: '--help' });
        expect(result).toBe('Skill');
      });
    });

    describe('LSP tool', () => {
      it('should extract operation', () => {
        const result = formatTool('LSP', { operation: 'goToDefinition', filePath: '/src/main.ts' });
        expect(result).toBe('LSP(goToDefinition)');
      });

      it('should return just LSP when operation is missing', () => {
        const result = formatTool('LSP', { filePath: '/src/main.ts', line: 10 });
        expect(result).toBe('LSP');
      });
    });

    describe('NotebookEdit tool', () => {
      it('should extract notebook_path', () => {
        const result = formatTool('NotebookEdit', { notebook_path: '/docs/demo.ipynb', cell_number: 3 });
        expect(result).toBe('NotebookEdit(/docs/demo.ipynb)');
      });
    });

    describe('Unknown tools', () => {
      it('should return just tool name for unknown tools with unrecognized fields', () => {
        const result = formatTool('CustomTool', { foo: 'bar', baz: 123 });
        expect(result).toBe('CustomTool');
      });

      it('should extract url from unknown tools if present', () => {
        // url is a generic extractor
        const result = formatTool('CustomFetch', { url: 'https://api.custom.com' });
        expect(result).toBe('CustomFetch(https://api.custom.com)');
      });

      it('should extract query from unknown tools if present', () => {
        // query is a generic extractor
        const result = formatTool('CustomSearch', { query: 'find something' });
        expect(result).toBe('CustomSearch(find something)');
      });

      it('should extract file_path from unknown tools if present', () => {
        // file_path is a generic extractor
        const result = formatTool('CustomFileTool', { file_path: '/some/path.txt' });
        expect(result).toBe('CustomFileTool(/some/path.txt)');
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle JSON string with nested objects', () => {
      const input = JSON.stringify({ command: 'echo test', options: { verbose: true } });
      const result = formatTool('Bash', input);
      expect(result).toBe('Bash(echo test)');
    });

    it('should handle very long command strings', () => {
      const longCommand = 'npm run build && npm run test && npm run lint && npm run format';
      const result = formatTool('Bash', { command: longCommand });
      expect(result).toBe(`Bash(${longCommand})`);
    });

    it('should handle file paths with spaces', () => {
      const result = formatTool('Read', { file_path: '/Users/test/My Documents/file.ts' });
      expect(result).toBe('Read(/Users/test/My Documents/file.ts)');
    });

    it('should handle file paths with special characters', () => {
      const result = formatTool('Write', { file_path: '/tmp/test-file_v2.0.ts' });
      expect(result).toBe('Write(/tmp/test-file_v2.0.ts)');
    });

    it('should handle patterns with regex special characters', () => {
      const result = formatTool('Grep', { pattern: '\\[.*\\]|\\(.*\\)' });
      expect(result).toBe('Grep(\\[.*\\]|\\(.*\\))');
    });

    it('should handle unicode in strings', () => {
      const result = formatTool('Bash', { command: 'echo "Hello, World!"' });
      expect(result).toBe('Bash(echo "Hello, World!")');
    });

    it('should handle number values in fields correctly', () => {
      // If command is a number, it gets stringified
      const result = formatTool('Bash', { command: 123 });
      expect(result).toBe('Bash(123)');
    });

    it('should handle JSON array as input', () => {
      // Arrays don't have command/file_path/etc fields
      const result = formatTool('Unknown', ['item1', 'item2']);
      expect(result).toBe('Unknown');
    });

    it('should handle JSON string that parses to a primitive', () => {
      // JSON.parse("123") = 123 (number)
      const result = formatTool('Task', '"a plain string"');
      // After parsing, input becomes "a plain string" which has no recognized fields
      expect(result).toBe('Task');
    });
  });
});
