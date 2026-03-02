/**
 * File Path Extractor Tests
 *
 * Tests extraction of file paths from tool inputs/responses.
 * Source: src/utils/file-path-extractor.ts
 */

import { describe, it, expect } from 'bun:test';
import { extractFilePathsFromTool } from '../../src/utils/file-path-extractor.js';

describe('File Path Extractor', () => {
  describe('Read/Write/Edit tools', () => {
    it('extracts file_path from Read tool', () => {
      const paths = extractFilePathsFromTool('Read', { file_path: '/home/user/project/src/main.py' }, null);
      expect(paths).toEqual(['/home/user/project/src/main.py']);
    });

    it('extracts file_path from Write tool', () => {
      const paths = extractFilePathsFromTool('Write', { file_path: '/tmp/output.txt', content: 'hello' }, null);
      expect(paths).toEqual(['/tmp/output.txt']);
    });

    it('extracts file_path from Edit tool', () => {
      const paths = extractFilePathsFromTool('Edit', {
        file_path: '/home/user/project/config.ts',
        old_string: 'foo',
        new_string: 'bar'
      }, null);
      expect(paths).toEqual(['/home/user/project/config.ts']);
    });

    it('extracts file_path from MultiEdit tool', () => {
      const paths = extractFilePathsFromTool('MultiEdit', { file_path: '/home/user/file.ts' }, null);
      expect(paths).toEqual(['/home/user/file.ts']);
    });
  });

  describe('NotebookEdit tool', () => {
    it('extracts notebook_path', () => {
      const paths = extractFilePathsFromTool('NotebookEdit', {
        notebook_path: '/home/user/analysis.ipynb',
        new_source: 'print(1)'
      }, null);
      expect(paths).toEqual(['/home/user/analysis.ipynb']);
    });
  });

  describe('Glob tool', () => {
    it('extracts path parameter', () => {
      const paths = extractFilePathsFromTool('Glob', {
        path: '/home/user/project/src',
        pattern: '**/*.ts'
      }, null);
      expect(paths).toEqual(['/home/user/project/src']);
    });

    it('returns empty for Glob without path', () => {
      const paths = extractFilePathsFromTool('Glob', { pattern: '**/*.ts' }, null);
      expect(paths).toEqual([]);
    });
  });

  describe('Grep tool', () => {
    it('extracts path parameter', () => {
      const paths = extractFilePathsFromTool('Grep', {
        path: '/home/user/project',
        pattern: 'TODO'
      }, null);
      expect(paths).toEqual(['/home/user/project']);
    });
  });

  describe('Bash tool', () => {
    it('extracts cd target path', () => {
      const paths = extractFilePathsFromTool('Bash', {
        command: 'cd /home/user/repos/legal-core && ls'
      }, null);
      expect(paths).toContain('/home/user/repos/legal-core');
    });

    it('extracts absolute paths from commands', () => {
      const paths = extractFilePathsFromTool('Bash', {
        command: 'cat /home/user/project/README.md'
      }, null);
      expect(paths).toContain('/home/user/project/README.md');
    });

    it('extracts quoted cd paths', () => {
      const paths = extractFilePathsFromTool('Bash', {
        command: 'cd "/home/user/path with spaces" && ls'
      }, null);
      expect(paths).toContain('/home/user/path with spaces');
    });

    it('filters out /dev/ and /proc/ paths', () => {
      const paths = extractFilePathsFromTool('Bash', {
        command: 'cat /dev/null; ls /proc/1/status; cat /home/user/file.txt'
      }, null);
      expect(paths).not.toContain('/dev/null');
      expect(paths).not.toContain('/proc/1/status');
      expect(paths).toContain('/home/user/file.txt');
    });
  });

  describe('unknown tools', () => {
    it('tries common field names', () => {
      const paths = extractFilePathsFromTool('CustomTool', {
        file_path: '/home/user/custom.txt'
      }, null);
      expect(paths).toEqual(['/home/user/custom.txt']);
    });
  });

  describe('edge cases', () => {
    it('returns empty for null input', () => {
      expect(extractFilePathsFromTool('Read', null, null)).toEqual([]);
    });

    it('returns empty for undefined input', () => {
      expect(extractFilePathsFromTool('Read', undefined, null)).toEqual([]);
    });

    it('handles string input (JSON)', () => {
      const paths = extractFilePathsFromTool(
        'Read',
        JSON.stringify({ file_path: '/home/user/file.ts' }),
        null
      );
      expect(paths).toEqual(['/home/user/file.ts']);
    });

    it('handles invalid JSON string input', () => {
      const paths = extractFilePathsFromTool('Read', 'not-json', null);
      expect(paths).toEqual([]);
    });

    it('deduplicates paths', () => {
      const paths = extractFilePathsFromTool('Bash', {
        command: 'cat /home/user/file.txt && cat /home/user/file.txt'
      }, null);
      const uniquePaths = paths.filter(p => p === '/home/user/file.txt');
      expect(uniquePaths).toHaveLength(1);
    });

    it('extracts paths from tool response too', () => {
      const paths = extractFilePathsFromTool(
        'CustomTool',
        { some_field: 'value' },
        { file_path: '/home/user/response-file.txt' }
      );
      expect(paths).toContain('/home/user/response-file.txt');
    });

    it('handles string tool response', () => {
      const paths = extractFilePathsFromTool(
        'CustomTool',
        { file_path: '/home/user/input.txt' },
        JSON.stringify({ path: '/home/user/output.txt' })
      );
      expect(paths).toContain('/home/user/input.txt');
      expect(paths).toContain('/home/user/output.txt');
    });
  });
});
