import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { cleanupGeneratedProjects, generateIn } from '../helpers/claude-md-generate.js';

afterEach(cleanupGeneratedProjects);

describe('CLAUDE.md direct-child pagination', () => {
  it('does not generate observations when the configured count is zero', () => {
    const project = generateIn({ files: ['src/direct.ts'], settings: { CLAUDE_MEM_CONTEXT_OBSERVATIONS: '0' },
      seed: `
      const id = store.createSDKSession('content', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory');
      store.storeObservation('memory', project, {
        type: 'discovery', title: 'Excluded by zero count', subtitle: null,
        narrative: 'synthetic fixture', facts: [], concepts: [],
        files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
      `,
    });
    expect(existsSync(join(project, 'src', 'CLAUDE.md'))).toBe(false);
  }, 30_000);

  it('includes an older direct child after the configured page is full of nested candidates', () => {
    const project = generateIn({ files: ['src/direct.ts'], settings: { CLAUDE_MEM_CONTEXT_OBSERVATIONS: '1' },
      seed: `
      for (let i = 0; i < 6; i++) {
        const memory = 'memory-' + i;
        const id = store.createSDKSession('content-' + i, project, 'prompt');
        store.ensureMemorySessionIdRegistered(id, memory);
        store.storeObservation(memory, project, {
          type: 'discovery', title: i === 0 ? 'Wanted direct child' : 'Nested candidate ' + i,
          subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
          files_read: [i === 0 ? 'src/direct.ts' : 'src/nested/n' + i + '.ts'], files_modified: []
        }, 1, 0, 100 + i);
      }
      `,
    });
    const context = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(context).toContain('Wanted direct child');
    expect(context).not.toContain('Nested candidate');
    // Spawns Bun and runs every migration on a fresh database: well past the
    // 5s default on a slow runner.
  }, 30_000);
  it('includes direct children recorded as absolute tool paths', () => {
    // Read/Edit/Write tool inputs store absolute file paths, while generate
    // looks folders up by their project-relative path.
    const project = generateIn({ files: ['src/auth/login.ts'],
      seed: ({ root, project }) => `
      const files = [
        ['Absolute-path edit', ${JSON.stringify(join(project, 'src', 'auth', 'login.ts'))}],
        ['Relative-path edit', 'src/auth/login.ts'],
        ['Backslash-path edit', 'src\\\\auth\\\\login.ts'],
        ['Other package with the same folder name', ${JSON.stringify(join(project, 'packages', 'widget', 'src', 'auth', 'button.ts'))}],
        ['Edit from another checkout of the project', ${JSON.stringify(join(root, 'old-clone', 'src', 'auth', 'login.ts'))}],
      ];
      files.forEach(([title, file], i) => {
        const memory = 'memory-' + i;
        const id = store.createSDKSession('content-' + i, project, 'prompt');
        store.ensureMemorySessionIdRegistered(id, memory);
        store.storeObservation(memory, project, {
          type: 'discovery', title,
          subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
          files_read: [], files_modified: [file]
        }, 1, 0, 100 + i);
      });
      `,
    });
    const context = readFileSync(join(project, 'src', 'auth', 'CLAUDE.md'), 'utf8');
    expect(context).toContain('Absolute-path edit');
    expect(context).toContain('Relative-path edit');
    expect(context).toContain('Backslash-path edit');
    // An absolute path elsewhere in the checkout that merely ends in src/auth is not a child.
    expect(context).not.toContain('Other package with the same folder name');
    // A checkout elsewhere that shares the project key keeps its history.
    expect(context).toContain('Edit from another checkout of the project');
  }, 30_000);
  it('lists days newest-first, matching the newest-first rows', () => {
    // Noon UTC, one day apart: two distinct local days in any time zone.
    const olderEpoch = Date.UTC(2026, 9, 16, 12); const newerEpoch = Date.UTC(2026, 9, 17, 12);
    const project = generateIn({ files: ['src/day.ts'],
      seed: `
      [['Older day edit', ${olderEpoch}], ['Newer day edit', ${newerEpoch}]].forEach(([title, epoch], i) => {
        const memory = 'memory-' + i;
        const id = store.createSDKSession('content-' + i, project, 'prompt');
        store.ensureMemorySessionIdRegistered(id, memory);
        store.storeObservation(memory, project, {
          type: 'discovery', title,
          subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
          files_read: [], files_modified: ['src/day.ts']
        }, 1, 0, epoch);
      });
      `,
    });
    const context = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    const dayHeaders = [...context.matchAll(/^### (.+)$/gm)].map(match => match[1]);
    expect(dayHeaders).toHaveLength(2);
    expect(context.indexOf('Newer day edit')).toBeLessThan(context.indexOf('Older day edit'));
    expect(context.indexOf(`### ${dayHeaders[0]}`)).toBeLessThan(context.indexOf('Newer day edit'));
    expect(context.indexOf('Older day edit')).toBeGreaterThan(context.indexOf(`### ${dayHeaders[1]}`));
  }, 30_000);
  it('heads each row with a file that is in the folder, not a same-named folder in another package', () => {
    const project = generateIn({ files: ['src/b.ts'],
      seed: ({ project }) => `
      const id = store.createSDKSession('content-0', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-0');
      // One edit touched a file in another package's src/ first, then this folder's file.
      store.storeObservation('memory-0', project, {
        type: 'discovery', title: 'Cross-package edit',
        subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
        files_read: [], files_modified: [${JSON.stringify(join(project, 'packages', 'w', 'src', 'a.ts'))}, ${JSON.stringify(join(project, 'src', 'b.ts'))}]
      }, 1, 0, 100);
      `,
    });
    const context = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(context).toContain('Cross-package edit');
    expect(context).toContain('**b.ts**');
    expect(context).not.toContain('**a.ts**');
  }, 30_000);
});
