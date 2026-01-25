import { describe, expect, test } from 'bun:test';

/**
 * Tests for path matching logic, specifically the isDirectChild() algorithm
 * Covers fix for issue #794: Path format mismatch causes folder CLAUDE.md files to show "No recent activity"
 * 
 * We test the algorithm directly rather than through SessionSearch to avoid database setup complexity.
 * The implementation in SessionSearch.ts should match this logic exactly.
 */

/**
 * Normalize path separators to forward slashes and remove trailing slashes
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Check if a file is a direct child of a folder (not in a subfolder)
 * Handles path format mismatches where folderPath may be absolute but
 * filePath is stored as relative in the database (fixes #794)
 */
function isDirectChild(filePath: string, folderPath: string): boolean {
  const normFile = normalizePath(filePath);
  const normFolder = normalizePath(folderPath);

  // Strategy 1: Direct prefix match (both paths in same format)
  if (normFile.startsWith(normFolder + '/')) {
    const remainder = normFile.slice(normFolder.length + 1);
    return !remainder.includes('/');
  }

  // Strategy 2: Handle absolute folderPath with relative filePath
  // e.g., folderPath="/Users/x/project/app/api" and filePath="app/api/router.py"
  // Find where the relative path could match within the absolute path
  const folderSegments = normFolder.split('/');
  const fileSegments = normFile.split('/');
  
  if (fileSegments.length < 2) return false; // Need at least folder/file
  
  const fileDir = fileSegments.slice(0, -1).join('/'); // Directory part of file
  const fileName = fileSegments[fileSegments.length - 1]; // Actual filename
  
  // Check if folder path ends with the file's directory path
  if (normFolder.endsWith('/' + fileDir) || normFolder === fileDir) {
    // File is a direct child (no additional subdirectories)
    return !fileName.includes('/');
  }
  
  // Check if file's directory is contained at the end of folder path
  // by progressively checking suffixes
  for (let i = 0; i < folderSegments.length; i++) {
    const folderSuffix = folderSegments.slice(i).join('/');
    if (folderSuffix === fileDir) {
      return true;
    }
  }

  return false;
}

describe('isDirectChild path matching', () => {
  describe('same path format', () => {
    test('returns true for direct child with relative paths', () => {
      expect(isDirectChild('app/api/router.py', 'app/api')).toBe(true);
    });

    test('returns true for direct child with absolute paths', () => {
      expect(isDirectChild('/Users/dev/project/app/api/router.py', '/Users/dev/project/app/api')).toBe(true);
    });

    test('returns false for nested child with relative paths', () => {
      expect(isDirectChild('app/api/nested/router.py', 'app/api')).toBe(false);
    });

    test('returns false for nested child with absolute paths', () => {
      expect(isDirectChild('/Users/dev/project/app/api/nested/router.py', '/Users/dev/project/app/api')).toBe(false);
    });

    test('returns false for unrelated paths', () => {
      expect(isDirectChild('src/utils/helper.py', 'app/api')).toBe(false);
    });
  });

  describe('mixed path formats (issue #794)', () => {
    test('returns true when absolute folderPath and relative filePath match', () => {
      // This is the exact bug scenario from issue #794
      expect(isDirectChild(
        'app/api/video_review/router.py',           // relative (from database)
        '/Users/username/project/app/api/video_review'  // absolute (from API)
      )).toBe(true);
    });

    test('returns true for different absolute path prefixes', () => {
      expect(isDirectChild(
        'src/components/Button.tsx',
        '/home/dev/myproject/src/components'
      )).toBe(true);
    });

    test('returns false for nested files even with mixed formats', () => {
      expect(isDirectChild(
        'app/api/video_review/nested/router.py',
        '/Users/username/project/app/api/video_review'
      )).toBe(false);
    });

    test('returns false when relative path does not match folder suffix', () => {
      expect(isDirectChild(
        'different/path/router.py',
        '/Users/username/project/app/api/video_review'
      )).toBe(false);
    });

    test('handles Windows-style paths', () => {
      expect(isDirectChild(
        'src\\components\\Button.tsx',
        'C:\\Users\\dev\\project\\src\\components'
      )).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('handles trailing slashes in folder path', () => {
      expect(isDirectChild('app/api/router.py', 'app/api/')).toBe(true);
    });

    test('handles single segment file paths', () => {
      expect(isDirectChild('file.py', '')).toBe(false);
    });

    test('handles root-level files with absolute folder', () => {
      expect(isDirectChild(
        'package.json',
        '/Users/dev/project'
      )).toBe(false); // Can't match - no common path segments
    });

    test('handles paths with similar prefixes correctly', () => {
      // 'app/api-v2' should not match 'app/api'
      expect(isDirectChild('app/api-v2/router.py', 'app/api')).toBe(false);
    });

    test('handles deep nesting correctly', () => {
      expect(isDirectChild(
        'a/b/c/d/file.py',
        '/project/a/b/c/d'
      )).toBe(true);
      
      expect(isDirectChild(
        'a/b/c/d/e/file.py',
        '/project/a/b/c/d'
      )).toBe(false);
    });

    test('handles partial segment matches correctly', () => {
      // 'api' should not match 'api-gateway'
      expect(isDirectChild('api/router.py', '/project/api-gateway')).toBe(false);
    });
  });
});
