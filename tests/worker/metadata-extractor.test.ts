import { describe, test, expect } from 'bun:test';
import { extractSourceMetadata } from '../../src/services/worker/metadata-extractor.js';

describe('extractSourceMetadata', () => {
  test('WebFetch with url extracts source_url', () => {
    const result = extractSourceMetadata('WebFetch', { url: 'https://example.com/page' });
    expect(result.tool_name).toBe('WebFetch');
    expect(result.source_url).toBe('https://example.com/page');
  });

  test('WebSearch with query extracts search_query', () => {
    const result = extractSourceMetadata('WebSearch', { query: 'typescript generics' });
    expect(result.tool_name).toBe('WebSearch');
    expect(result.search_query).toBe('typescript generics');
  });

  test('Bash with command extracts command', () => {
    const result = extractSourceMetadata('Bash', { command: 'ls -la /tmp' });
    expect(result.tool_name).toBe('Bash');
    expect(result.command).toBe('ls -la /tmp');
  });

  test('Read with file_path extracts file_path', () => {
    const result = extractSourceMetadata('Read', { file_path: '/src/index.ts' });
    expect(result.tool_name).toBe('Read');
    expect(result.file_path).toBe('/src/index.ts');
  });

  test('Write with file_path extracts file_path', () => {
    const result = extractSourceMetadata('Write', { file_path: '/src/output.ts' });
    expect(result.tool_name).toBe('Write');
    expect(result.file_path).toBe('/src/output.ts');
  });

  test('Edit with file_path extracts file_path', () => {
    const result = extractSourceMetadata('Edit', { file_path: '/src/config.ts' });
    expect(result.tool_name).toBe('Edit');
    expect(result.file_path).toBe('/src/config.ts');
  });

  test('NotebookEdit with notebook_path extracts file_path', () => {
    const result = extractSourceMetadata('NotebookEdit', { notebook_path: '/notebooks/analysis.ipynb' });
    expect(result.tool_name).toBe('NotebookEdit');
    expect(result.file_path).toBe('/notebooks/analysis.ipynb');
  });

  test('Glob with pattern extracts glob_pattern', () => {
    const result = extractSourceMetadata('Glob', { pattern: '**/*.ts' });
    expect(result.tool_name).toBe('Glob');
    expect(result.glob_pattern).toBe('**/*.ts');
  });

  test('Grep with pattern and path extracts search_pattern and search_path', () => {
    const result = extractSourceMetadata('Grep', { pattern: 'TODO', path: '/src' });
    expect(result.tool_name).toBe('Grep');
    expect(result.search_pattern).toBe('TODO');
    expect(result.search_path).toBe('/src');
  });

  test('Task with subagent_type extracts subagent_type', () => {
    const result = extractSourceMetadata('Task', { subagent_type: 'research' });
    expect(result.tool_name).toBe('Task');
    expect(result.subagent_type).toBe('research');
  });

  test('LSP with operation extracts lsp_operation', () => {
    const result = extractSourceMetadata('LSP', { operation: 'hover' });
    expect(result.tool_name).toBe('LSP');
    expect(result.lsp_operation).toBe('hover');
  });

  test('unknown tool with url extracts source_url via default case', () => {
    const result = extractSourceMetadata('CustomTool', { url: 'https://api.example.com/data' });
    expect(result.tool_name).toBe('CustomTool');
    expect(result.source_url).toBe('https://api.example.com/data');
  });

  test('unknown tool without url returns tool_name only', () => {
    const result = extractSourceMetadata('CustomTool', { foo: 'bar' });
    expect(result.tool_name).toBe('CustomTool');
    expect(result.source_url).toBeUndefined();
    expect(result.search_query).toBeUndefined();
    expect(result.command).toBeUndefined();
    expect(result.file_path).toBeUndefined();
    expect(result.glob_pattern).toBeUndefined();
    expect(result.search_pattern).toBeUndefined();
    expect(result.search_path).toBeUndefined();
    expect(result.subagent_type).toBeUndefined();
    expect(result.lsp_operation).toBeUndefined();
  });

  test('string toolInput with valid JSON is parsed correctly', () => {
    const result = extractSourceMetadata('WebFetch', JSON.stringify({ url: 'https://example.com' }));
    expect(result.tool_name).toBe('WebFetch');
    expect(result.source_url).toBe('https://example.com');
  });

  test('string toolInput with invalid JSON falls back gracefully', () => {
    const result = extractSourceMetadata('WebFetch', 'not valid json');
    expect(result.tool_name).toBe('WebFetch');
    expect(result.source_url).toBeUndefined();
  });

  test('null toolInput returns tool_name only', () => {
    const result = extractSourceMetadata('Bash', null);
    expect(result.tool_name).toBe('Bash');
    expect(result.command).toBeUndefined();
  });

  test('undefined toolInput returns tool_name only', () => {
    const result = extractSourceMetadata('Bash', undefined);
    expect(result.tool_name).toBe('Bash');
    expect(result.command).toBeUndefined();
  });

  test('missing expected field returns tool_name only', () => {
    const result = extractSourceMetadata('WebFetch', { query: 'not a url field' });
    expect(result.tool_name).toBe('WebFetch');
    expect(result.source_url).toBeUndefined();
  });
});
