import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
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
    const [ref] = scanMemorySource(memDir);
    expect(ref.indexFile?.fileName).toBe('MEMORY.md');
    const names = ref.files.map(f => f.fileName);
    expect(names).toContain('recent-work.md');
    expect(names).not.toContain('MEMORY.md');
    expect(ref.cwd).toBe('/home/u/code/mm/obs');
    expect(ref.project).toBe('obs');
  });

  it('accepts the parent project dir and finds its memory/ subdir', () => {
    const [ref] = scanMemorySource(join(root, '-home-u-code-mm-obs'));
    expect(ref.files.some(f => f.fileName === 'recent-work.md')).toBe(true);
  });

  it('dry-run counts ingestable files and skips the index', () => {
    const report = dryRunMemorySource(memDir);
    // recent-work.md + empty.md are ingestable; MEMORY.md is not.
    expect(report.totals.files).toBe(2);
    expect(report.dirs[0].indexSkipped).toBe(true);
    expect(report.totals.cwdUnresolved).toBe(0);
  });

  it('throws on a missing source', () => {
    expect(() => scanMemorySource(join(root, 'nope'))).toThrow();
  });
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
    const report = await ingestMemorySource(memDir, {}, {
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
    const report = await ingestMemorySource(memDir, {}, {
      storeMemoryObservation: async () => ({ id: 1, deduped: true }),
    });
    expect(report.stored).toBe(0);
    expect(report.deduped).toBe(1);
  });
});
