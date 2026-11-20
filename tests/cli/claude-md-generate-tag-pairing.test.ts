import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cleanupGeneratedProjects, generateIn } from '../helpers/claude-md-generate.js';

afterEach(cleanupGeneratedProjects);

// `claude-mem generate` rewrites the managed block of each folder's CLAUDE.md.
// A closing tag in the user's own text before the block was taken for the end
// of the block, so every run copied the text between them again and kept the
// old block.
describe('claude-mem generate pairs the context tags of an existing CLAUDE.md', () => {
  it('replaces only the block when a closing tag comes before it, and stays the same across runs', () => {
    const userText = '# Notes\n\nThe </claude-mem-context> tag closes the memory block.\n\n';
    const project = generateIn({ files: ['src/direct.ts'], runs: 2, seed: `
      const { writeFileSync } = await import('fs');
      writeFileSync('src/CLAUDE.md', ${JSON.stringify(`${userText}<claude-mem-context>\nstale memory\n</claude-mem-context>\n`)});
      const id = store.createSDKSession('content-tags', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-tags');
      store.storeObservation('memory-tags', project, {
        type: 'discovery', title: 'Fresh direct child', subtitle: null, narrative: 'native fixture',
        facts: [], concepts: [], files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
    ` });
    const claudeMd = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(claudeMd.startsWith(`${userText}<claude-mem-context>\n`)).toBe(true);
    expect(claudeMd.split('tag closes the memory block').length).toBe(2);
    expect(claudeMd).toContain('Fresh direct child');
    expect(claudeMd).not.toContain('stale memory');
    // Spawns Bun and runs every migration on a fresh database: well past the
    // 5s default on a slow runner.
  }, 30_000);
});
