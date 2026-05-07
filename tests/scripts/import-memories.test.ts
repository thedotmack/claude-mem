import { afterEach, describe, expect, it } from 'bun:test';

const originalNoMain = process.env.CLAUDE_MEM_IMPORT_MEMORIES_NO_MAIN;

describe('import-memories script', () => {
  afterEach(() => {
    if (originalNoMain === undefined) {
      delete process.env.CLAUDE_MEM_IMPORT_MEMORIES_NO_MAIN;
    } else {
      process.env.CLAUDE_MEM_IMPORT_MEMORIES_NO_MAIN = originalNoMain;
    }
  });

  it('rejects partial exports before worker import', async () => {
    process.env.CLAUDE_MEM_IMPORT_MEMORIES_NO_MAIN = '1';

    const { assertImportableExportData } = await import('../../scripts/import-memories.ts');

    expect(() => assertImportableExportData({
      metadata: {
        partial: true,
      },
    })).toThrow(
      'Partial exports are not importable because SDK session metadata is missing. Re-run export without --allow-partial before importing.',
    );
  });

  it('throws instead of exiting when used as an imported function', async () => {
    process.env.CLAUDE_MEM_IMPORT_MEMORIES_NO_MAIN = '1';

    const { importMemories } = await import('../../scripts/import-memories.ts');

    await expect(importMemories('/tmp/claude-mem-missing-import-file.json')).rejects.toThrow(
      'Input file not found: /tmp/claude-mem-missing-import-file.json',
    );
  });
});
