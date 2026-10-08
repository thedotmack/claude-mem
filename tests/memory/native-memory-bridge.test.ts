import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { MemoryFileWatcher } from '../../src/services/memory/file-watcher.js';
import { parseMemoryWatchRoots } from '../../src/services/memory/config.js';
import { boundMemoryQuery, memorySearchLookup, memorySearchQuery } from '../../src/cli/handlers/memory-search.js';
import { saveMemory } from '../../src/services/memory/save-memory.js';
import type { SaveMemoryInput } from '../../src/services/memory/save-memory.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temp = () => { const directory = mkdtempSync(path.join(tmpdir(), 'cmem-memory-bridge-')); directories.push(directory); return directory; };
const hook = (toolName: string, toolInput: unknown) => ({ sessionId: 'session', cwd: '/project', toolName, toolInput });

describe('native memory lookup recognition', () => {
  const native = path.join(homedir(), '.claude/projects/project/memory/feedback_testing.md');
  it('recognizes memory Read and scoped Grep but skips unrelated code', () => {
    expect(memorySearchQuery(hook('Read', { file_path: native }))).toBe('feedback testing');
    expect(memorySearchQuery(hook('Grep', { path: path.dirname(native), pattern: 'timeout' }))).toBe('timeout');
    expect(memorySearchQuery(hook('Read', { file_path: '/project/src/memory.ts' }))).toBeNull();
    expect(memorySearchQuery(hook('Grep', { path: '/project', pattern: 'memory' }))).toBeNull();
  });
  it('scopes custom roots exactly, rejects sibling-prefix paths and traversal', () => {
    expect(memorySearchQuery(hook('Read', { file_path: '/notes/own/lesson.md' }), ['/notes/own'])).toBe('lesson');
    expect(memorySearchLookup(hook('Read', { file_path: '/notes/own/lesson.md' }), ['/notes/own'])).toEqual({query:'lesson',memoryPath:'/notes/own/lesson.md'});
    expect(memorySearchQuery(hook('Read', { file_path: '/notes/own-other/lesson.md' }), ['/notes/own'])).toBeNull();
    expect(memorySearchQuery(hook('Read', { file_path: '/notes/own/../private/lesson.md' }), ['/notes/own'])).toBeNull();
  });
  it('handles quoted native Bash reads without evaluating shell commands', () => {
    expect(memorySearchQuery(hook('Bash', { command: `rg timeout '${path.dirname(native)}'` }))).toBe('timeout');
    expect(memorySearchQuery(hook('Bash', { command: 'echo ${}' }))).toBeNull();
    expect(memorySearchQuery(hook('Bash', { command: `node '${native}'` }))).toBeNull();
  });
  it('supports explicit local memory searches and never recurses into plugin tools or memory writes', () => {
    expect(memorySearchQuery(hook('memory_search', { query: 'previous deploy' }))).toBe('previous deploy');
    expect(memorySearchQuery(hook('mcp__other__memory_search', { query: 'deploy' }))).toBe('deploy');
    expect(memorySearchQuery(hook('mcp__claude_mem__memory_search', { query: 'deploy' }))).toBeNull();
    expect(memorySearchQuery(hook('mcp__mcp_search__mem_search', { query: 'deploy' }))).toBeNull();
    expect(memorySearchQuery(hook('memory', { command: 'create', path: '/memories/new.md' }))).toBeNull();
  });
  it('caps oversized queries and disables folder import without explicit project configuration', () => {
    expect(memorySearchQuery(hook('memory_search', { query: 'a'.repeat(10_000) }))?.length).toBe(500);
    expect(Buffer.byteLength(boundMemoryQuery('🙂'.repeat(500)), 'utf8')).toBeLessThanOrEqual(1024);
    expect(boundMemoryQuery('🙂'.repeat(500))).not.toContain('\uFFFD');
    expect(boundMemoryQuery('a' + '🙂'.repeat(500)).endsWith('\uD83D')).toBe(false);
    expect(parseMemoryWatchRoots('')).toEqual([]);
    expect(() => parseMemoryWatchRoots('[{"path":"/notes"}]')).toThrow();
    expect(() => parseMemoryWatchRoots('[{"path":"relative","project":"p"}]')).toThrow();
  });
});

describe('memory folder watcher', () => {
  it('preserves edited note narratives with real title dedup enabled, then deduplicates a restarted watcher', () => {
    const root = temp();
    const previousDedup = process.env.CLAUDE_MEM_DEDUP_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    const create = () => new MemoryFileWatcher([{ path: root, project: 'snapshot-project' }], note => saveMemory(manager as any, 'fallback', note), 10);
    try {
      const watcher = create();
      const file = path.join(root, 'preference.md');
      writeFileSync(file, 'Use a 15 second timeout.'); watcher.scan(0); watcher.scan(11);
      writeFileSync(file, 'Use a 30 second timeout instead.'); watcher.scan(20); watcher.scan(31); watcher.stop();
      const restarted = create(); restarted.scan(40); restarted.scan(51); restarted.stop();
      const rows = store.db.query('SELECT narrative, title, occurrence_count FROM observations ORDER BY id').all() as Array<{narrative:string;title:string;occurrence_count:number}>;
      expect(rows.map(row => row.narrative)).toEqual(['Use a 15 second timeout.', 'Use a 30 second timeout instead.']);
      expect(new Set(rows.map(row => row.title)).size).toBe(2);
      expect(rows.map(row => row.occurrence_count)).toEqual([1, 1]);
      expect(store.db.query('SELECT COUNT(*) AS n FROM dedup_meta').get()).toEqual({n:1});
    } finally {
      store.close();
      if (previousDedup === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
      else process.env.CLAUDE_MEM_DEDUP_ENABLED = previousDedup;
    }
  });

  it('debounces bursts, captures atomic writes and new files, and ignores source-only instruction blocks', () => {
    const root = temp();
    const saved: SaveMemoryInput[] = [];
    const watcher = new MemoryFileWatcher([{ path: root, project: 'p' }], note => saved.push(note), 100);
    writeFileSync(path.join(root, 'lesson.md'), 'initial');
    watcher.scan(0);
    writeFileSync(path.join(root, 'lesson.md'), 'final lesson');
    watcher.scan(50);
    watcher.scan(149);
    expect(saved).toHaveLength(0);
    watcher.scan(151);
    expect(saved.map(note => note.text)).toEqual(['final lesson']);
    watcher.scan(250);
    expect(saved).toHaveLength(1);
    writeFileSync(path.join(root, '.atomic'), 'atomic revision');
    renameSync(path.join(root, '.atomic'), path.join(root, 'lesson.md'));
    writeFileSync(path.join(root, 'second.md'), 'second lesson');
    writeFileSync(path.join(root, 'MEMORY.md'), '<!-- claude-mem-memory-instructions:start -->\nbridge directions\n<!-- claude-mem-memory-instructions:end -->');
    watcher.scan(300);
    watcher.scan(401);
    expect(saved.map(note => note.text)).toEqual(['final lesson', 'atomic revision', 'second lesson']);
    expect(saved.every(note => note.project === 'p' && note.metadata?.sourceFingerprint)).toBe(true);
    watcher.stop();
    writeFileSync(path.join(root, 'third.md'), 'after stop');
    watcher.scan(1000);
    expect(saved).toHaveLength(3);
  });

  it('refuses symlinks, oversize and non-Markdown files; retries failed saves', () => {
    const root = temp();
    const outside = temp();
    writeFileSync(path.join(outside, 'secret.md'), 'outside note');
    symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
    symlinkSync(outside, path.join(root, 'linked-dir'));
    writeFileSync(path.join(root, 'big.md'), 'x'.repeat(65_537));
    writeFileSync(path.join(root, 'skip.txt'), 'not Markdown');
    writeFileSync(path.join(root, 'allowed.md'), 'allowed');
    let attempts = 0;
    const saved: SaveMemoryInput[] = [];
    const watcher = new MemoryFileWatcher([{ path: root, project: 'p' }], note => { if (++attempts === 1) throw new Error('busy DB'); saved.push(note); }, 10);
    watcher.scan(0);
    watcher.scan(11);
    watcher.scan(12);
    expect(attempts).toBe(2);
    expect(saved.map(note => note.text)).toEqual(['allowed']);
  });

  it('survives a restarted watcher and separates duplicate checks by project', () => {
    const root = temp();
    writeFileSync(path.join(root, 'note.md'), 'durable preference');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, project TEXT, metadata TEXT)');
    const manager = {
      getConnection: () => db,
      getSessionStore: () => ({ getOrCreateManualSession: () => 'manual', storeObservation: (_session: string, project: string, observation: {title: string; metadata: string}) => {
        const result = db.query('INSERT INTO observations (title, project, metadata) VALUES (?, ?, ?)').run(observation.title, project, observation.metadata);
        return { id: Number(result.lastInsertRowid), createdAtEpoch: 0 };
      } }),
      getCloudSync: () => null, getChromaSync: () => null,
    };
    const run = (project: string) => {
      const watcher = new MemoryFileWatcher([{ path: root, project }], note => saveMemory(manager as any, 'fallback', note), 10);
      watcher.scan(0); watcher.scan(11); watcher.stop();
    };
    run('one'); run('one'); run('two');
    expect((db.query('SELECT COUNT(*) AS n FROM observations').get() as {n: number}).n).toBe(2);
    db.close();
  });

  it('keeps an existing deduplicated observation vector unchanged while nudging cloud sync', () => {
    let indexed = 0, nudged = 0;
    const manager = {
      getSessionStore: () => ({ getOrCreateManualSession: () => 'manual', storeObservation: () => ({id: 7, createdAtEpoch: 0, mergedIntoExisting: true}) }),
      getCloudSync: () => ({notify: () => { nudged++; }}),
      getChromaSync: () => ({ syncObservation: () => { indexed++; return Promise.resolve(); } }),
    };
    expect(saveMemory(manager as any, 'p', { text: 'proposed duplicate' }).message).toContain('matches existing');
    expect(indexed).toBe(0);
    expect(nudged).toBe(1);
  });

  it('deduplicates the same file fingerprint across concurrent processes', async () => {
    const root = temp();
    const database = path.join(root, 'race.db');
    const db = new Database(database);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE observations (id INTEGER PRIMARY KEY, title TEXT, project TEXT, metadata TEXT)');
    const module = path.resolve(import.meta.dir, '../../src/services/memory/save-memory.ts');
    const worker = path.join(root, 'save-race.ts');
    writeFileSync(worker, `import {Database} from 'bun:sqlite';
import {saveMemory} from ${JSON.stringify(module)};
const db = new Database(${JSON.stringify(database)}); db.exec('PRAGMA busy_timeout=5000');
const manager = {getConnection:()=>db,getSessionStore:()=>({getOrCreateManualSession:()=> 'manual',storeObservation:(_s,p,o)=>{const r=db.query('INSERT INTO observations (title, project, metadata) VALUES (?,?,?)').run(o.title,p,o.metadata);return {id:Number(r.lastInsertRowid),createdAtEpoch:0};}}),getCloudSync:()=>null,getChromaSync:()=>null};
saveMemory(manager,'p',{text:'note',metadata:{sourceFingerprint:'shared-race-fingerprint'}}); db.close();`);
    const children = Array.from({length: 4}, () => Bun.spawn([process.execPath, worker], { stdout: 'pipe', stderr: 'pipe' }));
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0, 0]);
    expect((db.query('SELECT COUNT(*) AS n FROM observations').get() as {n: number}).n).toBe(1);
    db.close();
  });
});
