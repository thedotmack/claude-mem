import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

describe('writeClaudeMdToFolder', () => {
  it('should create CLAUDE.md in new folder', () => {
    const folderPath = join(tempDir, 'new-folder');
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

  it('should create nested directories', () => {
    const folderPath = join(tempDir, 'deep', 'nested', 'folder');
    const content = 'Nested content';

    writeClaudeMdToFolder(folderPath, content);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);
    expect(existsSync(join(tempDir, 'deep'))).toBe(true);
    expect(existsSync(join(tempDir, 'deep', 'nested'))).toBe(true);
  });

  it('should not leave .tmp file after write (atomic write)', () => {
    const folderPath = join(tempDir, 'atomic-test');
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

  it('should not modify absolute paths even with projectRoot', async () => {
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
      [filePath],  // absolute path
      'test-project',
      37777,
      '/home/user/my-project'  // projectRoot should be ignored
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
