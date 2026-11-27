import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMAND = fileURLToPath(new URL('../fixtures/imessage/contacts-command.ts', import.meta.url));
const MAX_CONTACTS = 20_000;

describe('iMessage contacts import', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'claude-mem-contacts-'));
    const observer = join(directory, 'imessage-observer');
    mkdirSync(observer);
    path = join(observer, 'contacts.json');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function save(input: unknown, replace = false) {
    const result = spawnSync(process.execPath, [COMMAND, '--json', ...(replace ? ['--replace'] : [])], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory },
      input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const event = JSON.parse(result.stdout.trim());
    expect(event.type).toBe('contacts');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    expect(event.count).toBe(Object.keys(saved).length);
    return saved;
  }

  function addressBook(count: number): Record<string, string> {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [`+1555${String(index).padStart(7, '0')}`, `Person ${index}`]));
  }

  it('refreshes existing names at capacity, even after an address that cannot be added', () => {
    writeFileSync(path, JSON.stringify(addressBook(MAX_CONTACTS)));
    const saved = save({
      'new@example.com': 'Cannot add this name',
      '+15550000000': 'Updated first person',
      ' +15550000001 ': ' Updated second person ',
    });
    expect(Object.keys(saved)).toHaveLength(MAX_CONTACTS);
    expect(saved['new@example.com']).toBeUndefined();
    expect(saved['+15550000000']).toBe('Updated first person');
    expect(saved['+15550000001']).toBe('Updated second person');
  });

  it('fills the last slot without discarding later updates to existing addresses', () => {
    writeFileSync(path, JSON.stringify(addressBook(MAX_CONTACTS - 1)));
    const saved = save({
      'first@example.com': 'First addition',
      'overflow@example.com': 'No remaining slot',
      '+15550000000': 'Corrected name',
    });
    expect(Object.keys(saved)).toHaveLength(MAX_CONTACTS);
    expect(saved['first@example.com']).toBe('First addition');
    expect(saved['overflow@example.com']).toBeUndefined();
    expect(saved['+15550000000']).toBe('Corrected name');
  });

  it('replaces the old book, normalizes addresses and ignores invalid names', () => {
    writeFileSync(path, JSON.stringify({ 'old@example.com': 'Old name' }));
    const saved = save({
      ' ana@example.com ': ' Ana ',
      'ana@example.com': 'Ana updated',
      'long@example.com': 'x'.repeat(121),
      'empty@example.com': ' ',
      'number@example.com': 42,
      ' ': 'No address',
      ['x'.repeat(321)]: 'Too long',
    }, true);
    expect(saved).toEqual({ 'ana@example.com': 'Ana updated', 'long@example.com': 'x'.repeat(120) });
  });

  it('keeps the saved book when stdin is not a contacts object', () => {
    const previous = JSON.stringify({ 'ana@example.com': 'Ana' });
    writeFileSync(path, previous);
    const result = spawnSync(process.execPath, [COMMAND, '--json'], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory },
      input: '[]', encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(previous);
  });
});
