import { describe, expect, it, setSystemTime } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  classifySettingsDocument,
  ensureSettingsDocument,
  updateSettingsDocument,
} from '../../src/shared/settings-document.js';

const tempFile = (value?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'settings-document-'));
  const path = join(dir, 'settings.json');
  if (value !== undefined) writeFileSync(path, value);
  return path;
};

describe('settings document boundary', () => {
  it('classifies flat, nested, mixed, and unrelated env documents', () => {
    expect(classifySettingsDocument({ CLAUDE_MEM_MODEL: 'flat' })).toBe('flat');
    expect(classifySettingsDocument({ env: { CLAUDE_MEM_MODEL: 'nested' } })).toBe('nested');
    expect(classifySettingsDocument({ CLAUDE_MEM_MODEL: 'root', env: { CLAUDE_MEM_MODEL: 'nested' } })).toBe('flat');
    expect(classifySettingsDocument({ env: { PATH: '/bin' }, hooks: [] })).toBe('flat');
  });

  it('refuses invalid existing bytes and never rewrites them', () => {
    const path = tempFile('{"env":');
    const before = readFileSync(path, 'utf8');
    expect(updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'new' }).status).toBe('refused');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('preserves complete documents and uses explicit missing-file seeds', () => {
    const path = tempFile(JSON.stringify({ env: { CLAUDE_MEM_MODEL: 'old' }, hooks: ['keep'] }));
    expect(updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'new' }).status).toBe('updated');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ env: { CLAUDE_MEM_MODEL: 'new' }, hooks: ['keep'] });

    const missing = tempFile();
    expect(ensureSettingsDocument(missing, { callerSeed: true }).status).toBe('created');
    expect(JSON.parse(readFileSync(missing, 'utf8'))).toEqual({ callerSeed: true });
  });

  it('quarantines an unreadable file only when asked (installer), keeping its bytes', () => {
    const path = tempFile('{"CLAUDE_MEM_MODEL":"old"');
    const result = updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'new' }, {}, undefined, { quarantineCorrupt: true });
    expect(result.status).toBe('created');
    expect(result.quarantinedTo).toMatch(/settings\.json\.corrupt-\d+$/);
    expect(readFileSync(result.quarantinedTo!, 'utf8')).toBe('{"CLAUDE_MEM_MODEL":"old"');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ CLAUDE_MEM_MODEL: 'new' });
  });

  it('gives a second quarantine in the same millisecond its own name instead of replacing the first', () => {
    setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
    try {
      const path = tempFile('{"first":');
      const first = updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'a' }, {}, undefined, { quarantineCorrupt: true });
      writeFileSync(path, '{"second":');
      const second = updateSettingsDocument(path, { CLAUDE_MEM_MODEL: 'b' }, {}, undefined, { quarantineCorrupt: true });

      expect(first.status).toBe('created');
      expect(second.status).toBe('created');
      expect(second.quarantinedTo).not.toBe(first.quarantinedTo);
      expect(readFileSync(first.quarantinedTo!, 'utf8')).toBe('{"first":');
      expect(readFileSync(second.quarantinedTo!, 'utf8')).toBe('{"second":');
    } finally {
      setSystemTime();
    }
  });

  it('writes settings.json owner-only, including a previously world-readable file', () => {
    if (process.platform === 'win32') return;
    const created = tempFile();
    ensureSettingsDocument(created, { CLAUDE_MEM_MODEL: 'seed' });
    expect(statSync(created).mode & 0o777).toBe(0o600);

    const existing = tempFile(JSON.stringify({ CLAUDE_MEM_MODEL: 'old' }));
    chmodSync(existing, 0o644);
    updateSettingsDocument(existing, { CLAUDE_MEM_MODEL: 'new' });
    expect(statSync(existing).mode & 0o777).toBe(0o600);
  });

  it('moves the quarantined bytes back when the fresh write fails, so readers still find the file', () => {
    const path = tempFile('{"CLAUDE_MEM_MODEL":"old"');
    // A BigInt cannot be serialized, so the replacement write throws after the quarantine.
    const result = updateSettingsDocument(path, {}, {}, target => { target.CLAUDE_MEM_BAD = BigInt(1); }, { quarantineCorrupt: true });

    expect(result.status).toBe('refused');
    expect(result.quarantinedTo).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe('{"CLAUDE_MEM_MODEL":"old"');
    expect(readdirSync(dirname(path))).toEqual(['settings.json']);
  });

  it('writes into the env block of a wrapped document and keeps its root peers', () => {
    const path = tempFile(JSON.stringify({ theme: 'dark', env: { CLAUDE_MEM_MODEL: 'old', KEEP: 'yes' } }));
    updateSettingsDocument(path, {}, {}, target => { target.CLAUDE_MEM_MODEL = 'new'; });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark', env: { CLAUDE_MEM_MODEL: 'new', KEEP: 'yes' } });
  });
});
