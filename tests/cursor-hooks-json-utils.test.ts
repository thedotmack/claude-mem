import { describe, it, expect } from 'bun:test';
import {
  parseArrayField,
  jsonGet,
  getProjectName,
  isEmpty,
  urlEncode
} from '../src/utils/cursor-utils';

/**
 * Tests for Cursor Hooks JSON/Utility Functions
 *
 * These tests validate the logic used in common.sh bash utilities.
 * The TypeScript implementations in cursor-utils.ts mirror the bash logic,
 * allowing us to verify correct behavior and catch edge cases.
 *
 * The bash scripts use these functions:
 * - json_get: Extract fields from JSON, including array access
 * - get_project_name: Extract project name from workspace path
 * - is_empty: Check if a string is empty/null
 * - url_encode: URL-encode a string
 */

describe('Cursor Hooks JSON Utilities', () => {
  describe('parseArrayField', () => {
    it('parses simple array access', () => {
      const result = parseArrayField('workspace_roots[0]');
      expect(result).toEqual({ field: 'workspace_roots', index: 0 });
    });

    it('parses array access with higher index', () => {
      const result = parseArrayField('items[42]');
      expect(result).toEqual({ field: 'items', index: 42 });
    });

    it('returns null for simple field', () => {
      const result = parseArrayField('conversation_id');
      expect(result).toBeNull();
    });

    it('returns null for empty string', () => {
      const result = parseArrayField('');
      expect(result).toBeNull();
    });

    it('returns null for malformed array syntax', () => {
      expect(parseArrayField('field[]')).toBeNull();
      expect(parseArrayField('field[-1]')).toBeNull();
      expect(parseArrayField('[0]')).toBeNull();
    });

    it('handles underscores in field name', () => {
      const result = parseArrayField('my_array_field[5]');
      expect(result).toEqual({ field: 'my_array_field', index: 5 });
    });
  });

  describe('jsonGet', () => {
    const testJson = {
      conversation_id: 'conv-123',
      workspace_roots: ['/path/to/project', '/another/path'],
      nested: { value: 'nested-value' },
      empty_string: '',
      null_value: null
    };

    it('gets simple field', () => {
      expect(jsonGet(testJson, 'conversation_id')).toBe('conv-123');
    });

    it('gets array element with [0]', () => {
      expect(jsonGet(testJson, 'workspace_roots[0]')).toBe('/path/to/project');
    });

    it('gets array element with higher index', () => {
      expect(jsonGet(testJson, 'workspace_roots[1]')).toBe('/another/path');
    });

    it('returns fallback for missing field', () => {
      expect(jsonGet(testJson, 'nonexistent', 'default')).toBe('default');
    });

    it('returns fallback for out-of-bounds array access', () => {
      expect(jsonGet(testJson, 'workspace_roots[99]', 'default')).toBe('default');
    });

    it('returns fallback for array access on non-array', () => {
      expect(jsonGet(testJson, 'conversation_id[0]', 'default')).toBe('default');
    });

    it('returns empty string fallback by default', () => {
      expect(jsonGet(testJson, 'nonexistent')).toBe('');
    });

    it('returns fallback for null value', () => {
      expect(jsonGet(testJson, 'null_value', 'fallback')).toBe('fallback');
    });

    it('returns empty string value (not fallback)', () => {
      // Empty string is a valid value, should not trigger fallback
      expect(jsonGet(testJson, 'empty_string', 'fallback')).toBe('');
    });
  });

  describe('getProjectName', () => {
    it('extracts basename from Unix path', () => {
      expect(getProjectName('/Users/alex/projects/my-project')).toBe('my-project');
    });

    it('extracts basename from Windows path', () => {
      expect(getProjectName('C:\\Users\\alex\\projects\\my-project')).toBe('my-project');
    });

    it('handles path with trailing slash', () => {
      expect(getProjectName('/path/to/project/')).toBe('project');
    });

    it('returns unknown-project for empty string', () => {
      expect(getProjectName('')).toBe('unknown-project');
    });

    it('handles Windows drive root C:\\', () => {
      expect(getProjectName('C:\\')).toBe('drive-C');
    });

    it('handles Windows drive root C:', () => {
      expect(getProjectName('C:')).toBe('drive-C');
    });

    it('handles lowercase drive letter', () => {
      expect(getProjectName('d:\\')).toBe('drive-D');
    });

    it('handles project name with dots', () => {
      expect(getProjectName('/path/to/my.project.v2')).toBe('my.project.v2');
    });

    it('handles project name with spaces', () => {
      expect(getProjectName('/path/to/My Project')).toBe('My Project');
    });

    it('handles project name with special characters', () => {
      expect(getProjectName('/path/to/project-name_v2.0')).toBe('project-name_v2.0');
    });
  });

  describe('isEmpty', () => {
    it('returns true for null', () => {
      expect(isEmpty(null)).toBe(true);
    });

    it('returns true for undefined', () => {
      expect(isEmpty(undefined)).toBe(true);
    });

    it('returns true for empty string', () => {
      expect(isEmpty('')).toBe(true);
    });

    it('returns true for literal "null" string', () => {
      // This is important - jq returns "null" as string when value is null
      expect(isEmpty('null')).toBe(true);
    });

    it('returns true for literal "empty" string', () => {
      expect(isEmpty('empty')).toBe(true);
    });

    it('returns false for non-empty string', () => {
      expect(isEmpty('some-value')).toBe(false);
    });

    it('returns false for whitespace-only string', () => {
      // Whitespace is not empty
      expect(isEmpty('   ')).toBe(false);
    });

    it('returns false for "0" string', () => {
      expect(isEmpty('0')).toBe(false);
    });

    it('returns false for "false" string', () => {
      expect(isEmpty('false')).toBe(false);
    });
  });

  describe('urlEncode', () => {
    it('encodes spaces', () => {
      expect(urlEncode('hello world')).toBe('hello%20world');
    });

    it('encodes special characters', () => {
      expect(urlEncode('a&b=c')).toBe('a%26b%3Dc');
    });

    it('encodes unicode', () => {
      const encoded = urlEncode('日本語');
      expect(encoded).toContain('%');
      expect(decodeURIComponent(encoded)).toBe('日本語');
    });

    it('preserves alphanumeric characters', () => {
      expect(urlEncode('abc123')).toBe('abc123');
    });

    it('preserves dashes and underscores', () => {
      expect(urlEncode('my-project_name')).toBe('my-project_name');
    });

    it('handles empty string', () => {
      expect(urlEncode('')).toBe('');
    });

    it('encodes forward slash', () => {
      expect(urlEncode('path/to/file')).toBe('path%2Fto%2Ffile');
    });
  });

  describe('integration: hook payload parsing', () => {
    // Simulates parsing a real Cursor hook payload

    it('extracts all fields from typical beforeSubmitPrompt payload', () => {
      const payload = {
        conversation_id: 'abc-123',
        generation_id: 'gen-456',
        prompt: 'Fix the bug',
        workspace_roots: ['/Users/alex/projects/my-project'],
        hook_event_name: 'beforeSubmitPrompt'
      };

      const conversationId = jsonGet(payload, 'conversation_id');
      const workspaceRoot = jsonGet(payload, 'workspace_roots[0]');
      const projectName = getProjectName(workspaceRoot);
      const hookEvent = jsonGet(payload, 'hook_event_name');

      expect(conversationId).toBe('abc-123');
      expect(workspaceRoot).toBe('/Users/alex/projects/my-project');
      expect(projectName).toBe('my-project');
      expect(hookEvent).toBe('beforeSubmitPrompt');
    });

    it('handles payload with missing optional fields', () => {
      const payload = {
        generation_id: 'gen-456',
        // No conversation_id, no workspace_roots
      };

      const conversationId = jsonGet(payload, 'conversation_id', '');
      const workspaceRoot = jsonGet(payload, 'workspace_roots[0]', '');

      expect(isEmpty(conversationId)).toBe(true);
      expect(isEmpty(workspaceRoot)).toBe(true);
    });

    it('constructs valid API URL with encoded project name', () => {
      const projectName = 'my project (v2)';
      const port = 37777;
      const encoded = urlEncode(projectName);

      const url = `http://127.0.0.1:${port}/api/context/inject?project=${encoded}`;

      expect(url).toBe('http://127.0.0.1:37777/api/context/inject?project=my%20project%20(v2)');
    });
  });
});
