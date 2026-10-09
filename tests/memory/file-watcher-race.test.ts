import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryFileWatcher } from '../../src/services/memory/file-watcher.js';
import type { SaveMemoryInput } from '../../src/services/memory/save-memory.js';

describe('memory watcher opened-file containment', () => {
  it('rejects an outside descriptor opened through a raced parent directory and still captures safe revisions', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'cmem-watch-race-'));
    const root = path.join(directory, 'watched');
    const child = path.join(root, 'notes');
    const backup = path.join(root, '.safe-notes');
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(outside);
    const file = path.join(child, 'lesson.md');
    fs.writeFileSync(file, 'Safe note.');
    fs.writeFileSync(path.join(outside, 'lesson.md'), 'PRIVATE_OUTSIDE_NOTE');
    const canonicalFile = fs.realpathSync(file);
    const realOpen = fs.openSync;
    const realRead = fs.readFileSync;
    const realReadSync = fs.readSync;
    const outsideDescriptors = new Set<number>();
    let races = 0, outsideReads = 0;
    const saved: SaveMemoryInput[] = [];
    const watcher = new MemoryFileWatcher([{ path: root, project: 'race-project' }], note => saved.push(note), 10);
    const openSpy = spyOn(fs, 'openSync').mockImplementation(((candidate: fs.PathLike, flags: number, mode?: fs.Mode) => {
      if (candidate !== file && candidate !== canonicalFile) return realOpen(candidate, flags, mode);
      fs.renameSync(child, backup);
      fs.symlinkSync(outside, child, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        const fd = realOpen(candidate, flags, mode);
        outsideDescriptors.add(fd); races++;
        return fd;
      } finally {
        fs.unlinkSync(child); fs.renameSync(backup, child);
      }
    }) as typeof fs.openSync);
    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === 'number' && outsideDescriptors.has(args[0])) outsideReads++;
      return realRead(...args);
    }) as typeof fs.readFileSync);
    const readSyncSpy = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (outsideDescriptors.has(args[0])) outsideReads++;
      return realReadSync(...args);
    }) as typeof fs.readSync);
    try {
      try {
        watcher.scan(0); watcher.scan(11);
        expect(races).toBe(2);
        expect(outsideReads).toBe(0);
        expect(saved).toEqual([]);
        expect(fs.realpathSync(file)).toBe(canonicalFile);
      } finally {
        openSpy.mockRestore(); readSpy.mockRestore(); readSyncSpy.mockRestore();
      }
      watcher.scan(20); watcher.scan(31);
      expect(saved.map(note => note.text)).toEqual(['Safe note.']);
      const replacement = path.join(child, '.replacement');
      fs.writeFileSync(replacement, 'Safe atomic replacement.'); fs.renameSync(replacement, file);
      watcher.scan(40); watcher.scan(51); watcher.scan(70);
      expect(saved.map(note => note.text)).toEqual(['Safe note.', 'Safe atomic replacement.']);
      expect(saved.every(note => note.project === 'race-project' && note.metadata?.sourceFingerprint)).toBe(true);
    } finally {
      watcher.stop(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds the descriptor read and skips a concurrently growing note, then captures a stable revision', () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), 'cmem-watch-growth-'));
    const file = path.join(directory, 'lesson.md');
    fs.writeFileSync(file, 'small');
    const saved: SaveMemoryInput[] = [];
    const watcher = new MemoryFileWatcher([{ path: directory, project: 'snapshot-project' }], note => saved.push(note), 10);
    const realReadSync = fs.readSync;
    let changed = false, maximumBufferBytes = 0;
    const readSpy = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      maximumBufferBytes = Math.max(maximumBufferBytes, args[1].byteLength);
      if (!changed) { changed = true; fs.writeFileSync(file, 'x'.repeat(128 * 1024)); }
      return realReadSync(...args);
    }) as typeof fs.readSync);
    try {
      try {
        watcher.scan(0); watcher.scan(11);
        expect(changed).toBe(true);
        expect(maximumBufferBytes).toBe(6);
        expect(saved).toEqual([]);
      } finally { readSpy.mockRestore(); }
      fs.writeFileSync(file, 'Stable revised note.');
      watcher.scan(20); watcher.scan(31); watcher.scan(50);
      expect(saved.map(note => note.text)).toEqual(['Stable revised note.']);
    } finally {
      watcher.stop(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
