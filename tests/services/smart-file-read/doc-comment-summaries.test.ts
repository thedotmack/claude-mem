import { describe, expect, test } from 'bun:test';
import { nativeTest } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { docCommentSummary, formatFoldedView, parseFile } from '../../../src/services/smart-file-read/parser.js';
import { formatSearchResults, searchCodebase } from '../../../src/services/smart-file-read/search.js';

describe('doc comment summaries', () => {
  test('drop the closer of a one-line block comment', () => {
    expect(docCommentSummary('/** Returns the user id. */')).toBe('Returns the user id.');
    expect(docCommentSummary('/**Returns the user id.*/')).toBe('Returns the user id.');
    expect(docCommentSummary('/* Returns the user id. */')).toBe('Returns the user id.');
    expect(docCommentSummary('/**\n * Returns the user id.\n */')).toBe('Returns the user id.');
  });

  test('keep a line comment that ends in */ as text', () => {
    expect(docCommentSummary('// Matches /a*/')).toBe('Matches /a*/');
  });

  test('drop the quotes of a one-line docstring', () => {
    expect(docCommentSummary('"""Run the job."""')).toBe('Run the job.');
  });

  nativeTest('read the same in an outline and in search results', async () => {
    const typescript = '/** Returns the user id. */\nexport function userId(): string { return "u"; }\n';
    const python = 'def run_job():\n    """Run the job."""\n    pass\n';

    const outline = formatFoldedView(parseFile(typescript, 'user.ts'));
    expect(outline).toContain('💬 Returns the user id.');
    expect(outline).not.toContain('*/');

    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-doc-summaries-'));
    try {
      writeFileSync(join(dir, 'user.ts'), typescript);
      writeFileSync(join(dir, 'job.py'), python);
      const userId = formatSearchResults(await searchCodebase(dir, 'userId'), 'userId');
      expect(userId).toContain('💬 Returns the user id.');
      expect(userId).not.toContain('*/');
      const runJob = formatSearchResults(await searchCodebase(dir, 'run_job'), 'run_job');
      expect(runJob).toContain('💬 Run the job.');
      expect(runJob).not.toContain('"""');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
