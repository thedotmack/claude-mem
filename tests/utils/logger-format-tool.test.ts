import { describe, it, expect } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

const formatTool = (toolName: string, toolInput?: any): string => logger.formatTool(toolName, toolInput);

describe('logger.formatTool()', () => {
  it.each<[string, string, unknown, string]>([
    ['should parse JSON string and extract command for Bash', 'Bash', '{"command": "ls -la"}', 'Bash(ls -la)'],
    ['should parse JSON string and extract file_path', 'Read', '{"file_path": "/path/to/file.ts"}', 'Read(/path/to/file.ts)'],
    ['should parse JSON string and extract pattern for Glob', 'Glob', '{"pattern": "**/*.ts"}', 'Glob(**/*.ts)'],
    ['should parse JSON string and extract pattern for Grep', 'Grep', '{"pattern": "TODO|FIXME"}', 'Grep(TODO|FIXME)'],
    ['should handle raw command string without crashing', 'Bash', 'raw command string', 'Bash'],
    ['should handle malformed JSON gracefully', 'Read', '{file_path: broken}', 'Read'],
    ['should handle partial JSON gracefully', 'Write', '{"file_path":', 'Write'],
    ['should handle empty string input', 'Bash', '', 'Bash'],
    ['should handle string with special characters', 'Bash', 'echo "hello world" && ls', 'Bash'],
    ['should handle numeric string input', 'Task', '12345', 'Task'],
    ['should extract command from Bash object input', 'Bash', { command: 'echo hello' }, 'Bash(echo hello)'],
    ['should extract file_path from Read object input', 'Read', { file_path: '/src/index.ts' }, 'Read(/src/index.ts)'],
    ['should extract file_path from Write object input', 'Write', { file_path: '/output/result.json', content: 'data' }, 'Write(/output/result.json)'],
    ['should extract file_path from Edit object input', 'Edit', { file_path: '/src/utils.ts', old_string: 'foo', new_string: 'bar' }, 'Edit(/src/utils.ts)'],
    ['should extract pattern from Glob object input', 'Glob', { pattern: 'src/**/*.test.ts' }, 'Glob(src/**/*.test.ts)'],
    ['should extract pattern from Grep object input', 'Grep', { pattern: 'function\\s+\\w+', path: '/src' }, 'Grep(function\\s+\\w+)'],
    ['should extract notebook_path from NotebookEdit object input', 'NotebookEdit', { notebook_path: '/notebooks/analysis.ipynb' }, 'NotebookEdit(/notebooks/analysis.ipynb)'],
    ['should return just tool name when toolInput is undefined', 'Bash', undefined, 'Bash'],
    ['should return just tool name when toolInput is null', 'Bash', null, 'Bash'],
    ['should return just tool name when toolInput is undefined explicitly', 'Bash', undefined, 'Bash'],
    ['should return just tool name when toolInput is empty object', 'Bash', {}, 'Bash'],
    ['should return just tool name when toolInput is 0', 'Task', 0, 'Task'],
    ['should return just tool name when toolInput is false', 'Task', false, 'Task'],
    ['should extract command from object', 'Bash', { command: 'npm install' }, 'Bash(npm install)'],
    ['should extract command from JSON string', 'Bash', '{"command":"git status"}', 'Bash(git status)'],
    ['should return just Bash when command is missing', 'Bash', { description: 'some action' }, 'Bash'],
    ['should extract file_path', 'Read', { file_path: '/Users/test/file.ts' }, 'Read(/Users/test/file.ts)'],
    ['should extract file_path', 'Write', { file_path: '/tmp/output.txt', content: 'hello' }, 'Write(/tmp/output.txt)'],
    ['should extract file_path', 'Edit', { file_path: '/src/main.ts', old_string: 'a', new_string: 'b' }, 'Edit(/src/main.ts)'],
    ['should extract pattern', 'Grep', { pattern: 'import.*from' }, 'Grep(import.*from)'],
    ['should prioritize pattern over other fields', 'Grep', { pattern: 'search', path: '/src', type: 'ts' }, 'Grep(search)'],
    ['should extract pattern', 'Glob', { pattern: '**/*.md' }, 'Glob(**/*.md)'],
    ['should extract subagent_type when present', 'Task', { subagent_type: 'code_review' }, 'Task(code_review)'],
    ['should extract description when subagent_type is missing', 'Task', { description: 'Analyze the codebase structure' }, 'Task(Analyze the codebase structure)'],
    ['should prefer subagent_type over description', 'Task', { subagent_type: 'research', description: 'Find docs' }, 'Task(research)'],
    ['should return just Task when neither field is present', 'Task', { timeout: 5000 }, 'Task'],
    ['should extract url', 'WebFetch', { url: 'https://example.com/api' }, 'WebFetch(https://example.com/api)'],
    ['should extract query', 'WebSearch', { query: 'typescript best practices' }, 'WebSearch(typescript best practices)'],
    ['should extract skill name', 'Skill', { skill: 'commit' }, 'Skill(commit)'],
    ['should return just Skill when skill is missing', 'Skill', { args: '--help' }, 'Skill'],
    ['should extract operation', 'LSP', { operation: 'goToDefinition', filePath: '/src/main.ts' }, 'LSP(goToDefinition)'],
    ['should return just LSP when operation is missing', 'LSP', { filePath: '/src/main.ts', line: 10 }, 'LSP'],
    ['should extract notebook_path', 'NotebookEdit', { notebook_path: '/docs/demo.ipynb', cell_number: 3 }, 'NotebookEdit(/docs/demo.ipynb)'],
    ['should return just tool name for unknown tools with unrecognized fields', 'CustomTool', { foo: 'bar', baz: 123 }, 'CustomTool'],
    ['should extract url from unknown tools if present', 'CustomFetch', { url: 'https://api.custom.com' }, 'CustomFetch(https://api.custom.com)'],
    ['should extract query from unknown tools if present', 'CustomSearch', { query: 'find something' }, 'CustomSearch(find something)'],
    ['should extract file_path from unknown tools if present', 'CustomFileTool', { file_path: '/some/path.txt' }, 'CustomFileTool(/some/path.txt)'],
    ['should handle JSON string with nested objects', 'Bash', '{"command":"echo test","options":{"verbose":true}}', 'Bash(echo test)'],
    ['should handle very long command strings', 'Bash', { command: 'npm run build && npm run test && npm run lint && npm run format' }, 'Bash(npm run build && npm run test && npm run lint && npm run format)'],
    ['should handle file paths with spaces', 'Read', { file_path: '/Users/test/My Documents/file.ts' }, 'Read(/Users/test/My Documents/file.ts)'],
    ['should handle file paths with special characters', 'Write', { file_path: '/tmp/test-file_v2.0.ts' }, 'Write(/tmp/test-file_v2.0.ts)'],
    ['should handle patterns with regex special characters', 'Grep', { pattern: '\\[.*\\]|\\(.*\\)' }, 'Grep(\\[.*\\]|\\(.*\\))'],
    ['should handle unicode in strings', 'Bash', { command: 'echo "Hello, World!"' }, 'Bash(echo "Hello, World!")'],
    ['should handle number values in fields correctly', 'Bash', { command: 123 }, 'Bash(123)'],
    ['should handle JSON array as input', 'Unknown', [ 'item1', 'item2' ], 'Unknown'],
    ['should handle JSON string that parses to a primitive', 'Task', '"a plain string"', 'Task'],
  ])('%s', (_name, tool, input, expected) => {
    expect(formatTool(tool, input)).toBe(expected);
  });
});

// safeStringify is the depth-guarded serializer the DEBUG log path uses instead
// of a plain JSON.stringify, which overflows the stack on deeply nested or
// self-referential payloads ("RangeError: Maximum call stack size exceeded").
const safeStringify = (data: unknown, indent?: number): string =>
  (logger as any).safeStringify(data, indent);

describe('logger.safeStringify()', () => {
  it('serializes ordinary objects like JSON.stringify', () => {
    expect(safeStringify({ a: 1, b: 'x' })).toBe(JSON.stringify({ a: 1, b: 'x' }));
    expect(safeStringify({ a: 1 }, 2)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('truncates a nested object past the depth cap instead of recursing into it', () => {
    // Depth far beyond the serializer's cap: prune stops early, so it never
    // walks the whole chain (which is how a plain JSON.stringify overflows).
    let deep: any = {};
    let cursor = deep;
    for (let i = 0; i < 50; i++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    let out = '';
    expect(() => { out = safeStringify(deep, 2); }).not.toThrow();
    expect(out).toContain('[Object]'); // truncated past the depth cap
  });

  it('truncates a nested array past the depth cap', () => {
    let arr: any = [];
    let cursor = arr;
    for (let i = 0; i < 50; i++) {
      const child: any[] = [];
      cursor.push(child);
      cursor = child;
    }
    let out = '';
    expect(() => { out = safeStringify(arr, 2); }).not.toThrow();
    expect(out).toContain('[Array]');
  });

  it('serializes toJSON values (Date, URL) the way JSON.stringify does, not as {}', () => {
    const payload = { at: new Date(0), url: new URL('https://example.com/a?b=1') };
    expect(safeStringify(payload)).toBe(JSON.stringify(payload));
  });

  it('survives a throwing getter', () => {
    const obj = {
      get boom(): string { throw new Error('nope'); },
      ok: 1,
    };
    let out = '';
    expect(() => { out = safeStringify(obj); }).not.toThrow();
    expect(out).toContain('[unreadable]');
    expect(out).toContain('"ok":1');
  });
});

describe('logger.formatTool() parsed null input', () => {
  for (const toolName of ['Bash', 'Read', 'mcp__fixture__no_args']) {
    it(`formats JSON null for ${toolName} as no arguments`, () => {
      expect(formatTool(toolName, 'null')).toBe(toolName);
      expect(formatTool(toolName, '  null  ')).toBe(toolName);
    });
  }
});
