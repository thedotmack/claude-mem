import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChromaRecoveryHealth } from '../../../src/services/sync/ChromaRecoveryHealth.js';

let dataDir: string;
let priorDir: string | undefined;
beforeEach(() => {
  priorDir = process.env.CLAUDE_MEM_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'chroma-quarantine-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  ChromaRecoveryHealth.resetCacheForTests();
});
afterEach(() => {
  ChromaRecoveryHealth.resetCacheForTests();
  if (priorDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = priorDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('durable Chroma recovery journal', () => {
  it('writes DROP_PENDING synchronously before a destructive operation', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    const file = JSON.parse(readFileSync(join(dataDir, 'chroma-quarantine.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(file.collections.cm__alpha.state).toBe('DROP_PENDING');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('DROP_PENDING');
  });

  it('keeps a rejected delete quarantined after restart', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.quarantine('cm__alpha', new Error('transport deadline'));
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('QUARANTINED');
    expect(ChromaRecoveryHealth.isAvailable('cm__alpha')).toBe(false);
    expect(ChromaRecoveryHealth.isAvailable('cm__other')).toBe(true);
  });

  it('allows a confirmed delete to clear its journal before recovery proceeds', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.completeConfirmedDrop('cm__alpha');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('READY');
  });

  it('fails closed on corrupt or unsupported journal content', () => {
    writeFileSync(join(dataDir, 'chroma-quarantine.json'), '{"version":1,"collections":');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('UNKNOWN');
    expect(ChromaRecoveryHealth.isAvailable('cm__other')).toBe(false);
    expect(() => ChromaRecoveryHealth.beginDrop('cm__alpha')).toThrow('unreadable');
  });

  it('treats interrupted pending deletes as blocked, not healthy', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.isAvailable('cm__alpha')).toBe(false);
    expect(() => ChromaRecoveryHealth.beginDrop('cm__alpha')).toThrow('already');
  });
});

describe('journal-loss and interprocess transition safety', () => {
  const journal = () => join(dataDir, 'chroma-quarantine.json');

  it('keeps an initialization marker after a confirmed delete', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.completeConfirmedDrop('cm__alpha');
    expect(JSON.parse(readFileSync(journal() + '.initialized', 'utf8')).version).toBe(1);
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('READY');
  });

  it('does not silently heal when a journal disappears after a quarantine', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.quarantine('cm__alpha', new Error('lost Chroma reply'));
    unlinkSync(journal());
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('UNKNOWN');
    expect(ChromaRecoveryHealth.isAvailable('cm__other')).toBe(false);
  });

  it('fails closed if the crash left the marker but the journal never published', () => {
    writeFileSync(journal() + '.initialized', '{"version":1}');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('UNKNOWN');
  });

  it('blocks all Chroma dispatch when another process holds the transition lock', () => {
    writeFileSync(journal() + '.lock', 'owned by another worker');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('UNKNOWN');
    expect(() => ChromaRecoveryHealth.beginDrop('cm__alpha')).toThrow('unreadable');
  });

  it('rejects a corrupt initialization marker even if the journal is intact', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    writeFileSync(journal() + '.initialized', '{bad json');
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('UNKNOWN');
  });

  it('reloads state when another worker publishes a newer journal', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.quarantine('cm__alpha', new Error('timeout'));
    expect(ChromaRecoveryHealth.isAvailable('cm__beta')).toBe(true);
    // External writer on the same data-dir: replace journal through the same
    // atomic helper to exercise the changed-inode/mtime detection.
    const { writeJsonFileAtomic } = require('../../../src/shared/atomic-json.js');
    writeJsonFileAtomic(journal(), { version: 1, collections: {
      cm__alpha: { state: 'QUARANTINED', since: Date.now(), reason: 'timeout' },
      cm__beta: { state: 'DROP_PENDING', since: Date.now() },
    } });
    expect(ChromaRecoveryHealth.isAvailable('cm__beta')).toBe(false);
  });

  it('keeps other collection entries when a separate transition commits', () => {
    ChromaRecoveryHealth.beginDrop('cm__alpha');
    ChromaRecoveryHealth.quarantine('cm__alpha', new Error('bad segment'));
    ChromaRecoveryHealth.beginDrop('cm__beta');
    ChromaRecoveryHealth.quarantine('cm__beta', new Error('transport closed'));
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__alpha')).toBe('QUARANTINED');
    expect(ChromaRecoveryHealth.get('cm__beta')).toBe('QUARANTINED');
  });
});

describe('cross-process recovery coordination', () => {
  it('allows exactly one of four independent workers to start the same delete', async () => {
    const url = new URL('../../../src/services/sync/ChromaRecoveryHealth.ts', import.meta.url).href;
    const source = `
      import { ChromaRecoveryHealth } from ${JSON.stringify(url)};
      try {
        ChromaRecoveryHealth.beginDrop('cm__shared');
        process.stdout.write('ACQUIRED\\n');
        process.exit(0);
      } catch (error) {
        process.stderr.write(String(error) + '\\n');
        process.exit(12);
      }
    `;
    const children = Array.from({ length: 4 }, () => Bun.spawn(
      [process.execPath, '-e', source],
      { env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe' }
    ));
    const results = await Promise.all(children.map(async child => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })));
    if (results.filter(r => r.code === 0).length !== 1) console.error('cross-process diagnostics', results);
    expect(results.filter(r => r.code === 0)).toHaveLength(1);
    expect(results.filter(r => r.code === 12)).toHaveLength(3);
    ChromaRecoveryHealth.resetCacheForTests();
    expect(ChromaRecoveryHealth.get('cm__shared')).toBe('DROP_PENDING');
  }, 15_000);
});
