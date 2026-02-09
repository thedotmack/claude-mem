import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import path, { join } from 'path';
import { tmpdir } from 'os';

// Mock logger BEFORE imports (required pattern)
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    formatTool: (toolName: string, toolInput?: any) => toolInput ? `${toolName}(...)` : toolName,
  },
}));

// Import after mocks
import {
  replaceTaggedContent,
  formatTimelineForClaudeMd,
  writeClaudeMdToFolder,
  updateFolderClaudeMdFiles
} from '../../src/utils/claude-md-utils.js';

let tempDir: string;
const originalFetch = global.fetch;

beforeEach(() => {
  tempDir = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  mock.restore();
  global.fetch = originalFetch;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
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
  it('should return empty string for empty input', () => {
    const result = formatTimelineForClaudeMd('');

    expect(result).toBe('');
  });

  it('should return empty string when no table rows exist', () => {
    const input = 'Just some plain text without table rows';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toBe('');
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

describe('writeClaudeMdToFolder', () => {
  it('should skip non-existent folders (fix for spurious directory creation)', () => {
    const folderPath = join(tempDir, 'non-existent-folder');
    const content = '# Recent Activity\n\nTest content';

    // Should not throw, should silently skip
    writeClaudeMdToFolder(folderPath, content);

    // Folder and CLAUDE.md should NOT be created
    expect(existsSync(folderPath)).toBe(false);
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should create CLAUDE.md in existing folder', () => {
    const folderPath = join(tempDir, 'existing-folder');
    mkdirSync(folderPath, { recursive: true });
    const content = '# Recent Activity\n\nTest content';

    writeClaudeMdToFolder(folderPath, content);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const fileContent = readFileSync(claudeMdPath, 'utf-8');
    expect(fileContent).toContain('<claude-mem-context>');
    expect(fileContent).toContain('Test content');
    expect(fileContent).toContain('</claude-mem-context>');
  });

  it('should preserve user content outside tags', () => {
    const folderPath = join(tempDir, 'preserve-test');
    mkdirSync(folderPath, { recursive: true });

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    const userContent = 'User-written docs\n<claude-mem-context>\nOld content\n</claude-mem-context>\nMore user docs';
    writeFileSync(claudeMdPath, userContent);

    const newContent = 'New generated content';
    writeClaudeMdToFolder(folderPath, newContent);

    const fileContent = readFileSync(claudeMdPath, 'utf-8');
    expect(fileContent).toContain('User-written docs');
    expect(fileContent).toContain('New generated content');
    expect(fileContent).toContain('More user docs');
    expect(fileContent).not.toContain('Old content');
  });

  it('should not create nested directories (fix for spurious directory creation)', () => {
    const folderPath = join(tempDir, 'deep', 'nested', 'folder');
    const content = 'Nested content';

    // Should not throw, should silently skip
    writeClaudeMdToFolder(folderPath, content);

    // Nested directories should NOT be created
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
    expect(existsSync(join(tempDir, 'deep'))).toBe(false);
  });

  it('should not leave .tmp file after write (atomic write)', () => {
    const folderPath = join(tempDir, 'atomic-test');
    mkdirSync(folderPath, { recursive: true });
    const content = 'Atomic write test';

    writeClaudeMdToFolder(folderPath, content);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    const tempFilePath = `${claudeMdPath}.tmp`;

    expect(existsSync(claudeMdPath)).toBe(true);
    expect(existsSync(tempFilePath)).toBe(false);
  });
});

describe('updateFolderClaudeMdFiles', () => {
  it('should skip when filePaths is empty', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles([], 'test-project', 37777);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should fetch timeline and write CLAUDE.md', async () => {
    const folderPath = join(tempDir, 'api-test');
    mkdirSync(folderPath, { recursive: true }); // Folder must exist - we no longer create directories
    const filePath = join(folderPath, 'test.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));

    await updateFolderClaudeMdFiles([filePath], 'test-project', 37777);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const content = readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Recent Activity');
    expect(content).toContain('#123');
    expect(content).toContain('Test observation');
  });

  it('should deduplicate folders from multiple files', async () => {
    const folderPath = join(tempDir, 'dedup-test');
    const file1 = join(folderPath, 'file1.ts');
    const file2 = join(folderPath, 'file2.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles([file1, file2], 'test-project', 37777);

    // Should only fetch once for the shared folder
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should handle API errors gracefully (404 response)', async () => {
    const folderPath = join(tempDir, 'error-test');
    const filePath = join(folderPath, 'test.ts');

    global.fetch = mock(() => Promise.resolve({
      ok: false,
      status: 404
    } as Response));

    // Should not throw
    await expect(updateFolderClaudeMdFiles([filePath], 'test-project', 37777)).resolves.toBeUndefined();

    // CLAUDE.md should not be created
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should handle network errors gracefully (fetch throws)', async () => {
    const folderPath = join(tempDir, 'network-error-test');
    const filePath = join(folderPath, 'test.ts');

    global.fetch = mock(() => Promise.reject(new Error('Network error')));

    // Should not throw
    await expect(updateFolderClaudeMdFiles([filePath], 'test-project', 37777)).resolves.toBeUndefined();

    // CLAUDE.md should not be created
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should resolve relative paths using projectRoot', async () => {
    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['src/utils/file.ts'],  // relative path
      'test-project',
      37777,
      '/home/user/my-project'  // projectRoot
    );

    // Should call API with absolute path /home/user/my-project/src/utils
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/my-project/src/utils'));
  });

  it('should accept absolute paths within projectRoot and use them directly', async () => {
    const folderPath = join(tempDir, 'absolute-path-test');
    const filePath = join(folderPath, 'file.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      [filePath],  // absolute path within tempDir
      'test-project',
      37777,
      tempDir  // projectRoot matches the absolute path's root
    );

    // Should call API with the original absolute path's folder
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent(folderPath));
  });

  it('should work without projectRoot for backward compatibility', async () => {
    const folderPath = join(tempDir, 'backward-compat-test');
    const filePath = join(folderPath, 'file.ts');

    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      [filePath],  // absolute path
      'test-project',
      37777
      // No projectRoot - backward compatibility
    );

    // Should still make API call with the folder path
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent(folderPath));
  });

  it('should handle projectRoot with trailing slash correctly', async () => {
    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test observation | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    // projectRoot WITH trailing slash
    await updateFolderClaudeMdFiles(
      ['src/utils/file.ts'],
      'test-project',
      37777,
      '/home/user/my-project/'  // trailing slash
    );

    // Should call API with normalized path (no double slashes)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    // path.join normalizes the path, so /home/user/my-project/ + src/utils becomes /home/user/my-project/src/utils
    expect(callUrl).toContain(encodeURIComponent('/home/user/my-project/src/utils'));
    // Should NOT contain double slashes (except in http://)
    expect(callUrl.replace('http://', '')).not.toContain('//');
  });

  it('should write CLAUDE.md to resolved projectRoot path', async () => {
    const subfolderPath = join(tempDir, 'project-root-write-test', 'src', 'utils');
    mkdirSync(subfolderPath, { recursive: true }); // Folder must exist - we no longer create directories

    const apiResponse = {
      content: [{
        text: '| #456 | 5:00 PM | 🔵 | Written to correct path | ~200 |'
      }]
    };

    global.fetch = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));

    // Use tempDir as projectRoot with relative path src/utils/file.ts
    await updateFolderClaudeMdFiles(
      ['src/utils/file.ts'],
      'test-project',
      37777,
      join(tempDir, 'project-root-write-test')
    );

    // Verify CLAUDE.md was written at the resolved absolute path
    const claudeMdPath = join(subfolderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const content = readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Written to correct path');
    expect(content).toContain('#456');
  });

  it('should deduplicate relative paths from same folder with projectRoot', async () => {
    const apiResponse = {
      content: [{
        text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |'
      }]
    };

    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    // Multiple files in same folder (relative paths)
    await updateFolderClaudeMdFiles(
      ['src/utils/file1.ts', 'src/utils/file2.ts', 'src/utils/file3.ts'],
      'test-project',
      37777,
      '/home/user/project'
    );

    // Should only fetch once for the shared folder
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/project/src/utils'));
  });

  it('should handle empty string paths gracefully with projectRoot', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['', 'src/file.ts', ''],  // includes empty strings
      'test-project',
      37777,
      '/home/user/project'
    );

    // Should skip empty strings and only process valid path
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/home/user/project/src'));
  });
});

describe('path validation in updateFolderClaudeMdFiles', () => {
  it('should reject tilde paths', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['~/.claude-mem/logs/worker.log'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject URLs', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['https://example.com/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with spaces', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['PR #610 on thedotmack/CLAUDE.md'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with hash symbols', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['issue#123/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject path traversal outside project', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['../../../etc/passwd'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject absolute paths outside project root', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['/etc/passwd'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should accept absolute paths within project root', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    // Create an absolute path within the temp directory
    const absolutePathInProject = path.join(tempDir, 'src', 'utils', 'file.ts');

    await updateFolderClaudeMdFiles(
      [absolutePathInProject],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should accept absolute paths when no projectRoot is provided', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['/home/user/valid/file.ts'],
      'test-project',
      37777
      // No projectRoot provided
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should accept valid relative paths', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['src/utils/logger.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('issue #814 - reject consecutive duplicate path segments', () => {
  it('should reject paths with consecutive duplicate segments like frontend/frontend/', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    // Simulate cwd=/project/frontend/ receiving relative path frontend/src/file.ts
    // resolves to /project/frontend/frontend/src/file.ts
    await updateFolderClaudeMdFiles(
      ['frontend/src/file.ts'],
      'test-project',
      37777,
      path.join(tempDir, 'frontend')  // cwd is already inside frontend/
    );

    // Should NOT make API call because resolved path has frontend/frontend/
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should reject paths with consecutive duplicate segments like src/src/', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['src/components/file.ts'],
      'test-project',
      37777,
      path.join(tempDir, 'src')  // cwd is already inside src/
    );

    // resolved path = tempDir/src/src/components/file.ts → has src/src/
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should allow paths with non-consecutive duplicate segments', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    // Non-consecutive: src/components/src/utils → allowed
    await updateFolderClaudeMdFiles(
      ['src/components/src/utils/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    // Should process because segments are non-consecutive
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('issue #859 - skip folders with active CLAUDE.md', () => {
  it('should skip folder when CLAUDE.md was read in observation', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    // Simulate reading CLAUDE.md - should skip that folder
    await updateFolderClaudeMdFiles(
      ['/project/src/utils/CLAUDE.md'],
      'test-project',
      37777,
      '/project'
    );

    // Should NOT make API call since the CLAUDE.md file was read
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip folder when CLAUDE.md was modified in observation', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    // Simulate modifying CLAUDE.md - should skip that folder
    await updateFolderClaudeMdFiles(
      ['/project/src/CLAUDE.md'],
      'test-project',
      37777,
      '/project'
    );

    // Should NOT make API call since the CLAUDE.md file was modified
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should process other folders even when one has active CLAUDE.md', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    // Mix of CLAUDE.md read and other files
    await updateFolderClaudeMdFiles(
      [
        '/project/src/utils/CLAUDE.md',  // Should skip /project/src/utils
        '/project/src/services/api.ts'   // Should process /project/src/services
      ],
      'test-project',
      37777,
      '/project'
    );

    // Should make ONE API call for /project/src/services, NOT for /project/src/utils
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/project/src/services'));
    expect(callUrl).not.toContain(encodeURIComponent('/project/src/utils'));
  });

  it('should handle relative CLAUDE.md paths with projectRoot', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    // Relative path to CLAUDE.md
    await updateFolderClaudeMdFiles(
      ['src/components/CLAUDE.md'],
      'test-project',
      37777,
      '/project'
    );

    // Should NOT make API call since CLAUDE.md was accessed
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip only the specific folder containing active CLAUDE.md', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    // Two CLAUDE.md files in different folders, plus a regular file
    await updateFolderClaudeMdFiles(
      [
        '/project/src/a/CLAUDE.md',
        '/project/src/b/CLAUDE.md',
        '/project/src/c/file.ts'
      ],
      'test-project',
      37777,
      '/project'
    );

    // Should only process folder c, not a or b
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(callUrl).toContain(encodeURIComponent('/project/src/c'));
  });

  it('should still exclude project root even when CLAUDE.md filter would allow it', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    // Create a temp dir with .git to simulate project root
    const projectRoot = join(tempDir, 'git-project');
    const gitDir = join(projectRoot, '.git');
    mkdirSync(gitDir, { recursive: true });

    // File at project root
    await updateFolderClaudeMdFiles(
      [join(projectRoot, 'file.ts')],
      'test-project',
      37777,
      projectRoot
    );

    // Should NOT make API call because it's the project root
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('issue #912 - skip unsafe directories for CLAUDE.md generation', () => {
  it('should skip node_modules directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['node_modules/lodash/index.js'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip .git directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['.git/refs/heads/main'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip Android res/ directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['app/src/main/res/layout/activity_main.xml'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip build/ directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['build/outputs/apk/debug/app-debug.apk'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should skip __pycache__/ directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['src/__pycache__/module.cpython-311.pyc'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should allow safe directories like src/', async () => {
    const apiResponse = {
      content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }]
    };
    const fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiResponse)
    } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles(
      ['src/utils/file.ts'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should skip deeply nested unsafe directories', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    // node_modules nested deep inside project
    await updateFolderClaudeMdFiles(
      ['packages/frontend/node_modules/react/index.js'],
      'test-project',
      37777,
      tempDir
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
