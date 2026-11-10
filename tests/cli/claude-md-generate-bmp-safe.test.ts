import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cleanupGeneratedProjects, generateIn } from '../helpers/claude-md-generate.js';

afterEach(cleanupGeneratedProjects);

// #2787: the managed block is auto-loaded context, and a Claude Code truncation
// can cut it inside a surrogate pair. `claude-mem generate` wrote observation
// titles as they were, so an emoji in a title put a pair into the CLAUDE.md.
describe('claude-mem generate writes a BMP-only CLAUDE.md block', () => {
  it('replaces an astral character in an observation title', () => {
    const project = generateIn({ files: ['src/direct.ts'], seed: `
      const id = store.createSDKSession('content-bmp', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-bmp');
      store.storeObservation('memory-bmp', project, {
        type: 'feature', title: 'Ship the \u{1F680} release', subtitle: null, narrative: 'native fixture',
        facts: [], concepts: [], files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
    ` });
    const claudeMd = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Ship the • release');
    expect([...claudeMd].filter(ch => ch.codePointAt(0)! > 0xffff)).toEqual([]);
    // Spawns Bun and runs every migration on a fresh database: well past the
    // 5s default on a slow runner.
  }, 30_000);

  it('also holds for `npm run claude-md:regenerate`, whose type markers are emoji', () => {
    const project = generateIn({ files: ['src/direct.ts'], writer: 'regenerate', seed: `
      const id = store.createSDKSession('content-bmp', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-bmp');
      store.storeObservation('memory-bmp', project, {
        type: 'feature', title: 'Ship the \u{1F680} release', subtitle: null, narrative: 'native fixture',
        facts: [], concepts: [], files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
    ` });
    const claudeMd = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Ship the • release');
    expect([...claudeMd].filter(ch => ch.codePointAt(0)! > 0xffff)).toEqual([]);
  }, 30_000);
});
