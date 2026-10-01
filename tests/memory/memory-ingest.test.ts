import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseMemoryFrontmatter,
  deriveTitle,
  scanMemorySource,
  dryRunMemorySource,
  buildMemoryObservation,
  ingestMemorySource,
  memoryDirForCwd,
  MemorySourceError,
  MAX_MEMORY_FILE_BYTES,
  type MemoryDirRef,
  type MemoryFileRef,
  type MemoryObservationToStore,
} from '../../src/services/memory/ingest.js';

const FM = [
  '---',
  'name: recent-work',
  'description: "What was done last session"',
  'metadata:',
  '  node_type: memory',
  '  type: project',
  '  originSessionId: abc-123',
  '---',
  '',
  '## Recent Work',
  '',
  '- did a thing with alertmanager',
].join('\n');

describe('parseMemoryFrontmatter', () => {
  it('extracts name/description and nested metadata.type/originSessionId, strips body', () => {
    const { frontmatter, body } = parseMemoryFrontmatter(FM);
    expect(frontmatter.name).toBe('recent-work');
    expect(frontmatter.description).toBe('What was done last session');
    expect(frontmatter.type).toBe('project');
    expect(frontmatter.originSessionId).toBe('abc-123');
    expect(frontmatter.nodeType).toBe('memory');
    expect(body.startsWith('## Recent Work')).toBe(true);
    expect(body).not.toContain('originSessionId');
  });

  it('returns empty frontmatter and original body when there is no block', () => {
    const raw = '# Just markdown\n\nno frontmatter here';
    const { frontmatter, body } = parseMemoryFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('does not treat an unterminated --- as frontmatter', () => {
    const raw = '---\nname: x\n(no close)';
    const { frontmatter, body } = parseMemoryFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });
});

describe('deriveTitle', () => {
  it('prefers frontmatter name', () => {
    expect(deriveTitle('f.md', { name: 'the-name' }, '# H1\n')).toBe('the-name');
  });
  it('falls back to first H1 then H2 then filename', () => {
    expect(deriveTitle('f.md', {}, '## only h2\n')).toBe('only h2');
    expect(deriveTitle('topic.md', {}, 'plain text, no heading')).toBe('topic');
    expect(deriveTitle('f.md', {}, '# the h1\n## later h2')).toBe('the h1');
  });
});

describe('memoryDirForCwd', () => {
  it('encodes the cwd path with dashes', () => {
    expect(memoryDirForCwd('/home/u/code/mm/obs')).toContain('-home-u-code-mm-obs/memory');
  });

  it('dashes dots too, as Claude Code names its project dirs', () => {
    expect(memoryDirForCwd('/Users/john.doe/proj')).toContain('-Users-john-doe-proj/memory');
  });
});

describe('scanMemorySource', () => {
  let root: string;
  let memDir: string;

  beforeEach(() => {
    // Layout: <root>/<encoded>/{*.jsonl, memory/{MEMORY.md, recent-work.md, empty.md}}
    root = mkdtempSync(join(tmpdir(), 'memscan-'));
    const projectDir = join(root, '-home-u-code-mm-obs');
    memDir = join(projectDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    // Sibling transcript carrying cwd, so project resolves.
    writeFileSync(
      join(projectDir, 's.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/home/u/code/mm/obs', message: { content: 'hi' } }) + '\n'
    );
    writeFileSync(join(memDir, 'MEMORY.md'), '# Index\n- [recent](recent-work.md)\n');
    writeFileSync(join(memDir, 'recent-work.md'), FM);
    writeFileSync(join(memDir, 'empty.md'), '---\nname: empty\n---\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('enumerates topic files, skips the MEMORY.md index, resolves cwd', () => {
    const [ref] = scanMemorySource(memDir, { root });
    expect(ref.indexFile?.fileName).toBe('MEMORY.md');
    const names = ref.files.map(f => f.fileName);
    expect(names).toContain('recent-work.md');
    expect(names).not.toContain('MEMORY.md');
    expect(ref.cwd).toBe('/home/u/code/mm/obs');
    expect(ref.project).toBe('obs');
  });

  it('accepts the parent project dir and finds its memory/ subdir', () => {
    const [ref] = scanMemorySource(join(root, '-home-u-code-mm-obs'), { root });
    expect(ref.files.some(f => f.fileName === 'recent-work.md')).toBe(true);
  });

  it('dry-run counts ingestable files and skips the index', () => {
    const report = dryRunMemorySource(memDir, { root });
    // recent-work.md + empty.md are ingestable; MEMORY.md is not.
    expect(report.totals.files).toBe(2);
    expect(report.dirs[0].indexSkipped).toBe(true);
    expect(report.totals.cwdUnresolved).toBe(0);
  });

  it('throws on a missing source', () => {
    expect(() => scanMemorySource(join(root, 'nope'), { root })).toThrow(MemorySourceError);
  });

  it('refuses a source outside the projects directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'memscan-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), '# not a memory\n');
      expect(() => scanMemorySource(outside, { root })).toThrow(MemorySourceError);
      expect(() => scanMemorySource(join(root, '..'), { root })).toThrow(MemorySourceError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never follows a symlinked note file, and stores nothing from it (R5-4)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'memscan-secret-'));
    try {
      const secrets = join(outside, 'credentials');
      writeFileSync(secrets, '[default]\naws_secret_access_key = SHOULD-NEVER-BE-STORED\n');
      symlinkSync(secrets, join(memDir, 'notes.md'), 'file');

      const [ref] = scanMemorySource(memDir, { root });
      expect(ref.files.map(f => f.fileName)).not.toContain('notes.md');
      expect(ref.skipped.map(entry => entry.fileName)).toEqual(['notes.md']);

      const stored: MemoryObservationToStore[] = [];
      const report = await ingestMemorySource(memDir, { root }, {
        storeMemoryObservation: async obs => {
          stored.push(obs);
          return { id: stored.length, deduped: false };
        },
      });
      expect(JSON.stringify(stored)).not.toContain('SHOULD-NEVER-BE-STORED');
      expect(report.files.find(f => f.file === 'notes.md')?.status).toBe('skipped');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips a note larger than the size cap', () => {
    writeFileSync(join(memDir, 'huge.md'), `# huge\n\n${'x'.repeat(MAX_MEMORY_FILE_BYTES + 1)}`);

    const [ref] = scanMemorySource(memDir, { root });
    expect(ref.files.map(f => f.fileName)).not.toContain('huge.md');
    expect(ref.skipped.map(entry => entry.fileName)).toEqual(['huge.md']);
  });

  it('does not follow a symlinked memory dir out of the projects directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'memscan-link-'));
    try {
      writeFileSync(join(outside, 'secret.md'), '# outside\n\nprivate notes');
      const linkedProject = join(root, '-home-u-code-linked');
      mkdirSync(linkedProject);
      symlinkSync(outside, join(linkedProject, 'memory'), 'dir');

      expect(() => scanMemorySource(linkedProject, { root })).toThrow(MemorySourceError);
      const swept = scanMemorySource(root, { all: true, root });
      expect(swept.map(ref => ref.encodedName)).toEqual(['-home-u-code-mm-obs']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable file and still reads the rest',
    () => {
      const locked = join(memDir, 'locked.md');
      writeFileSync(locked, '# locked\n\nunreadable');
      chmodSync(locked, 0o000);
      try {
        const [ref] = scanMemorySource(memDir, { root });
        expect(ref.unreadable.map(entry => entry.fileName)).toEqual(['locked.md']);
        expect(ref.files.map(f => f.fileName)).toContain('recent-work.md');
        expect(dryRunMemorySource(memDir, { root }).totals.unreadable).toBe(1);
      } finally {
        chmodSync(locked, 0o644);
      }
    },
  );
});

describe('buildMemoryObservation', () => {
  const ref = { project: 'obs', cwd: '/home/u/code/mm/obs', encodedName: '-enc' } as MemoryDirRef;
  const file = {
    fileName: 'recent-work.md',
    title: 'recent-work',
    body: '## Recent Work\n- thing',
    mtimeEpoch: 1_700_000_000_000,
    frontmatter: { type: 'project', originSessionId: 'abc-123', description: 'desc' },
  } as MemoryFileRef;

  it('maps body→narrative, backdates to mtime, carries provenance', () => {
    const obs = buildMemoryObservation(ref, file);
    expect(obs.project).toBe('obs');
    expect(obs.type).toBe('discovery');
    expect(obs.title).toBe('recent-work');
    expect(obs.narrative).toBe('## Recent Work\n- thing');
    expect(obs.createdAtEpoch).toBe(1_700_000_000_000);
    expect(obs.concepts).toContain('memory-import');
    expect(obs.concepts).toContain('memory-type:project');
    expect(obs.metadata.originSessionId).toBe('abc-123');
    expect(obs.metadata.source).toBe('memory-import');
    expect(obs.subtitle).toBe('desc');
  });
});

describe('ingestMemorySource (fake deps)', () => {
  let root: string;
  let memDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memingest-'));
    const projectDir = join(root, '-home-u-code-mm-obs');
    memDir = join(projectDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(projectDir, 's.jsonl'),
      JSON.stringify({ type: 'user', cwd: '/home/u/code/mm/obs', message: { content: 'hi' } }) + '\n'
    );
    writeFileSync(join(memDir, 'MEMORY.md'), '# Index\n');
    writeFileSync(join(memDir, 'a.md'), FM);
    writeFileSync(join(memDir, 'empty.md'), '---\nname: empty\n---\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stores non-index, non-empty files and skips empty bodies', async () => {
    const stored: MemoryObservationToStore[] = [];
    const report = await ingestMemorySource(memDir, { root }, {
      storeMemoryObservation: async obs => {
        stored.push(obs);
        return { id: stored.length, deduped: false };
      },
    });
    expect(report.found).toBe(2); // a.md + empty.md (MEMORY.md excluded at scan)
    expect(report.stored).toBe(1); // a.md only
    expect(report.skipped).toBe(1); // empty.md skipped (empty body)
    expect(stored.map(o => o.title)).toEqual(['recent-work']);
  });

  it('reports deduped when the store says so (idempotency)', async () => {
    const report = await ingestMemorySource(memDir, { root }, {
      storeMemoryObservation: async () => ({ id: 1, deduped: true }),
    });
    expect(report.stored).toBe(0);
    expect(report.deduped).toBe(1);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports an unreadable file as failed and stores the rest (one bad file never aborts the run)',
    async () => {
      const locked = join(memDir, 'locked.md');
      writeFileSync(locked, '# locked\n\nunreadable');
      chmodSync(locked, 0o000);
      try {
        const report = await ingestMemorySource(memDir, { root }, {
          storeMemoryObservation: async () => ({ id: 1, deduped: false }),
        });
        expect(report.stored).toBe(1);
        expect(report.failed).toBe(1);
        expect(report.files.find(f => f.file === 'locked.md')?.status).toBe('failed');
      } finally {
        chmodSync(locked, 0o644);
      }
    },
  );
});
