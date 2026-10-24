import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join, parse } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { LIBRARY_BACKUPS_KEPT, LibraryBackupChange, libraryBackupChangeFolders, libraryBackupsDirectory } from '../../src/services/wire-gateway/library/backups.js';
import {
  applyLibrary,
  assertLibraryRuntime,
  libraryStatus,
  removeLibrary,
} from '../../src/services/wire-gateway/library/library-engine.js';
import { libraryRecordPath, readLibraryRecords } from '../../src/services/wire-gateway/library/library-record.js';
import { contextBlockItem, mcpMemberItem } from '../../src/services/wire-gateway/library/agent-library-targets.js';
import type { ConfigMemberItem, LibraryValue, JsonArrayEntryItem, LibraryItem, OwnedFileItem, TextBlockItem } from '../../src/services/wire-gateway/library/types.js';

// The Library engine's rules (plan Phase 14 tasks 1-3 and verification):
// only recorded entries are claude-mem's; an entry the user edited becomes
// theirs; an unparseable file is never written; every write is backed up
// (the last 30 changes kept); a remove gives back the exact bytes.

const ROOT = join(WIRE_GATEWAY_DIR, 'tmp', `library-engine-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let counter = 0;

function sandbox(): { dir: string; context: { libraryDirectory: string } } {
  const dir = join(ROOT, String(counter++));
  mkdirSync(dir, { recursive: true });
  return { dir, context: { libraryDirectory: join(dir, 'library') } };
}

/** A hook whose command starts with `cm ` (its signature, as real hook items carry one). */
function hookItem(file: string, command: string, event = 'stop'): JsonArrayEntryItem {
  return {
    kind: 'hook', id: `hook:${event}`, group: 'hooks', place: 'json-array-entry', file, arrayKeyPath: ['hooks', event], entry: { command },
    isPreLibraryEntry: (entry) => String((entry as { command?: unknown }).command).startsWith('cm '),
  };
}

const read = (path: string) => readFileSync(path, 'utf-8');
/** Where a file sits inside an agent's part of a backup change: its absolute path without the root. */
const backupPathOf = (path: string) => path.slice(parse(path).root.length);

describe('Library engine: ownership', () => {
  it('appends its hook after the user\'s, and a second sync changes nothing', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    writeFileSync(file, JSON.stringify({ hooks: { stop: [{ command: './mine.sh' }] } }, null, 2) + '\n');
    applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    const once = read(file);
    expect(JSON.parse(once).hooks.stop).toEqual([{ command: './mine.sh' }, { command: 'cm stop' }]);
    const result = applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    expect(read(file)).toBe(once);
    expect(result.items[0].outcome).toBe('unchanged');
    expect(result.filesWritten).toEqual([]);
  });

  it('an edited hook becomes the user\'s: never rewritten, never removed', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    const edited = read(file).replace('cm stop', 'cm stop --verbose');
    writeFileSync(file, edited);

    const sync = applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop v2')], ownedGroups: ['hooks'] }, context);
    expect(sync.items[0].outcome).toBe('left-to-user');
    expect(read(file)).toBe(edited);
    expect(libraryStatus('agent', context).items[0].state).toBe('released-to-user');

    removeLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop v2')] }, context);
    expect(read(file)).toBe(edited);
  });

  it('an entry the user deleted is written again on the next sync', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    writeFileSync(file, JSON.stringify({ hooks: { stop: [] } }, null, 2) + '\n');
    expect(libraryStatus('agent', context).items[0].state).toBe('edited-by-user');
    applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    expect(JSON.parse(read(file)).hooks.stop).toEqual([{ command: 'cm stop' }]);
  });

  it('an unrecorded value under a generic name is the user\'s; under claude-mem\'s own name it is adopted', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { 'mcp-search': { command: 'theirs' }, 'claude-mem': { command: 'old' } } }, null, 2) + '\n');
    const generic: LibraryItem = { kind: 'mcp', id: 'mcp:generic', group: 'mcp', place: 'member', file, format: 'json', keyPath: ['mcpServers', 'mcp-search'], value: { command: 'ours' }, whenUnrecorded: 'leave' };
    const named = mcpMemberItem(file, ['mcpServers', 'claude-mem'], { command: 'ours' });
    const result = applyLibrary({ agentId: 'agent', items: [generic, named], ownedGroups: ['mcp'] }, context);
    expect(result.items.map((item) => item.outcome)).toEqual(['left-to-user', 'written']);
    expect(JSON.parse(read(file)).mcpServers).toEqual({ 'mcp-search': { command: 'theirs' }, 'claude-mem': { command: 'ours' } });
    removeLibrary({ agentId: 'agent', items: [generic, named] }, context);
    expect(JSON.parse(read(file)).mcpServers).toEqual({ 'mcp-search': { command: 'theirs' } });
  });

  it('a replaced value is put back exactly on remove', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'known.json');
    writeFileSync(file, JSON.stringify({ thedotmack: { installLocation: '/old' }, mine: 1 }, null, 2) + '\n');
    const item: LibraryItem = { kind: 'setting', id: 's', group: 'settings', place: 'member', file, format: 'json', keyPath: ['thedotmack'], value: { installLocation: '/new' }, whenUnrecorded: 'replace-and-stash' };
    applyLibrary({ agentId: 'agent', items: [item], ownedGroups: ['settings'] }, context);
    writeFileSync(file, read(file).replace('"mine": 1', '"mine": 2'));
    removeLibrary({ agentId: 'agent', items: [item] }, context);
    expect(JSON.parse(read(file))).toEqual({ thedotmack: { installLocation: '/old' }, mine: 2 });
  });

  it('a group an apply owns loses the items it no longer asks for; other groups stay', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    const stop = hookItem(file, 'cm stop');
    const start: JsonArrayEntryItem = { ...hookItem(file, 'cm start', 'start'), group: 'other' };
    applyLibrary({ agentId: 'agent', items: [stop, start], ownedGroups: ['hooks', 'other'] }, context);
    applyLibrary({ agentId: 'agent', items: [], ownedGroups: ['hooks'] }, context);
    expect(JSON.parse(read(file)).hooks).toEqual({ start: [{ command: 'cm start' }] });
  });
});

describe('Library engine: instruction blocks (plan task 1, edit detection by hash)', () => {
  const block = (file: string, body: string): TextBlockItem => ({
    kind: 'instructions', id: 'instructions', group: 'instructions', place: 'text-block', file,
    open: '<!-- claude-mem:begin · written by claude-mem -->', close: '<!-- claude-mem:end -->', body, placement: 'after-trimmed-text',
  });

  it('goes after the user\'s text; an edited block stays the user\'s until claude-mem\'s own text changes', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'AGENTS.md');
    writeFileSync(file, '# My rules\n');
    applyLibrary({ agentId: 'agent', items: [block(file, 'Use memory.')], ownedGroups: ['instructions'] }, context);
    expect(read(file)).toBe('# My rules\n\n<!-- claude-mem:begin · written by claude-mem -->\nUse memory.\n<!-- claude-mem:end -->\n');

    const edited = read(file).replace('Use memory.', 'Use memory, briefly.');
    writeFileSync(file, edited);
    expect(applyLibrary({ agentId: 'agent', items: [block(file, 'Use memory.')], ownedGroups: ['instructions'] }, context).items[0].outcome).toBe('left-to-user');
    expect(read(file)).toBe(edited);
    expect(libraryStatus('agent', context).items[0].state).toBe('edited-by-user');

    applyLibrary({ agentId: 'agent', items: [block(file, 'Use memory v2.')], ownedGroups: ['instructions'] }, context);
    expect(read(file)).toContain('Use memory v2.');
    expect(readLibraryRecords(context.libraryDirectory).agent.instructionsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('remove of an untouched file gives back its exact bytes; a block-only file goes away', () => {
    const { dir, context } = sandbox();
    const kept = join(dir, 'GEMINI.md');
    const created = join(dir, 'NEW.md');
    writeFileSync(kept, 'no final newline');
    applyLibrary({ agentId: 'agent', items: [block(kept, 'x'), { ...block(created, 'y'), id: 'other' }], ownedGroups: ['instructions'] }, context);
    removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(read(kept)).toBe('no final newline');
    expect(existsSync(created)).toBe(false);
  });

  it('a runtime-managed context block is claude-mem\'s by its markers whatever its body', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'WARP.md');
    writeFileSync(file, '# Warp\n');
    applyLibrary({ agentId: 'agent', items: [contextBlockItem(file, 'placeholder', 'after-trimmed-text')], ownedGroups: ['instructions'] }, context);
    writeFileSync(file, read(file).replace('placeholder', 'refreshed memory'));
    removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(read(file)).toBe('# Warp\n');
  });
});

describe('Library engine: files the user owns', () => {
  it('never writes a file it cannot parse, and rolls back every file of the change', () => {
    const { dir, context } = sandbox();
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(() => applyLibrary({ agentId: 'agent', items: [hookItem(good, 'a'), { ...hookItem(bad, 'b'), id: 'b' }], ownedGroups: ['hooks'] }, context)).toThrow(/left as it is/);
    expect(existsSync(good)).toBe(false);
    expect(read(bad)).toBe('{ not json');
    expect(readLibraryRecords(context.libraryDirectory).agent).toBeUndefined();
  });

  it('edits a JSONC file in place: comments, indentation and trailing commas survive', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    const original = '{\n    // keep me\n    "hooks": {\n        "stop": [ { "command": "./mine.sh" }, ],\n    },\n}\n';
    writeFileSync(file, original);
    applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    const written = read(file);
    expect(written).toContain('// keep me');
    expect(written.startsWith('{\n    // keep me\n    "hooks": {\n')).toBe(true);
    expect(written).toContain('"cm stop"');
    removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(read(file)).toBe(original);
  });

  it('backs up each file before its first write in a change and keeps the newest 30 changes', () => {
    expect(LIBRARY_BACKUPS_KEPT).toBe(30);
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    writeFileSync(file, '{}\n');
    // 33 invocations, each its own change.
    for (let index = 0; index < 33; index++) {
      const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      applyLibrary({ agentId: 'agent', items: [hookItem(file, `cm ${index}`)], ownedGroups: ['hooks'] }, { ...context, now, backupChange: new LibraryBackupChange(context.libraryDirectory, now) });
    }
    const changes = libraryBackupChangeFolders(context.libraryDirectory);
    expect(changes).toHaveLength(30);
    // The oldest kept change is the 4th: it backed up the file as the 3rd left it.
    expect(read(join(libraryBackupsDirectory(context.libraryDirectory), changes[0], 'agent', backupPathOf(file)))).toContain('cm 2');
  });

  it('one CLI invocation is one change: every apply and remove of the process shares its folder', () => {
    const { dir, context } = sandbox();
    const hooks = join(dir, 'hooks.json');
    const mcp = join(dir, 'mcp.json');
    writeFileSync(hooks, '{}\n');
    writeFileSync(mcp, '{}\n');
    applyLibrary({ agentId: 'agent', items: [hookItem(hooks, 'cm stop')], ownedGroups: ['hooks'] }, context);
    applyLibrary({ agentId: 'agent', items: [mcpMemberItem(mcp, ['mcpServers', 'claude-mem'], { command: 'node' })], ownedGroups: ['mcp'] }, context);
    applyLibrary({ agentId: 'agent', items: [hookItem(hooks, 'cm stop v2')], ownedGroups: ['hooks'] }, context);
    const changes = libraryBackupChangeFolders(context.libraryDirectory);
    expect(changes).toHaveLength(1);
    // Each file once, with its bytes from before the invocation's first write.
    expect(read(join(libraryBackupsDirectory(context.libraryDirectory), changes[0], 'agent', backupPathOf(hooks)))).toBe('{}\n');
    expect(read(join(libraryBackupsDirectory(context.libraryDirectory), changes[0], 'agent', backupPathOf(mcp)))).toBe('{}\n');
  });

  it('orders same-millisecond changes by their sequence number (10 after 2) and never overwrites a same-named file', () => {
    const { dir, context } = sandbox();
    const sameMillisecond = () => new Date(Date.UTC(2026, 0, 1));
    const file = join(dir, 'hooks.json');
    writeFileSync(file, '{}\n');
    for (let index = 0; index < 32; index++) {
      applyLibrary({ agentId: 'agent', items: [hookItem(file, `cm ${index}`)], ownedGroups: ['hooks'] }, { ...context, now: sameMillisecond, backupChange: new LibraryBackupChange(context.libraryDirectory, sameMillisecond) });
    }
    const changes = libraryBackupChangeFolders(context.libraryDirectory);
    expect(changes).toHaveLength(30);
    // The two oldest went (1 and 2); 10 stays, and 32 is the newest.
    const sequences = changes.map((name) => Number(name.split('_')[0]));
    expect(sequences[0]).toBe(3);
    expect(sequences).toContain(10);
    expect(sequences.at(-1)).toBe(32);

    // Three files named settings.json in one change: each kept at its own path.
    const change = new LibraryBackupChange(context.libraryDirectory, () => new Date(Date.UTC(2027, 0, 1)));
    const paths = ['a', 'b', 'c'].map((name) => join(dir, name, 'settings.json'));
    paths.forEach((path, index) => change.keep('agent', path, new TextEncoder().encode(`file ${index}`)));
    const newest = libraryBackupChangeFolders(context.libraryDirectory).at(-1)!;
    paths.forEach((path, index) => expect(read(join(libraryBackupsDirectory(context.libraryDirectory), newest, 'agent', backupPathOf(path)))).toBe(`file ${index}`));
  });

  it('a library.json that does not parse stops every command (unknown is not empty)', () => {
    const { dir, context } = sandbox();
    mkdirSync(context.libraryDirectory, { recursive: true });
    writeFileSync(join(context.libraryDirectory, 'library.json'), '{ broken');
    expect(() => applyLibrary({ agentId: 'agent', items: [hookItem(join(dir, 'h.json'), 'x')], ownedGroups: ['hooks'] }, context)).toThrow(/cannot be read/);
  });

  it('runs only under Bun', () => {
    expect(() => assertLibraryRuntime()).not.toThrow();
  });
});

describe('Library engine: bundles', () => {
  it('a bundle file the user changed is theirs; its folder is removed only when empty', () => {
    const { dir, context } = sandbox();
    const root = join(dir, 'ext', 'claude-mem');
    const items: LibraryItem[] = ['index.js', 'lib/a.js'].map((name) => ({ kind: 'bundle', id: name, group: 'bundle', place: 'file', path: join(root, name), contents: new TextEncoder().encode(name), bundleRoot: root }));
    applyLibrary({ agentId: 'agent', items, ownedGroups: ['bundle'] }, context);
    writeFileSync(join(root, 'index.js'), 'edited');
    removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(read(join(root, 'index.js'))).toBe('edited');
    expect(existsSync(join(root, 'lib'))).toBe(false);
    expect(existsSync(join(dir, 'ext'))).toBe(true);
  });
});

describe('Library engine: user edits stay the user\'s (task 3)', () => {
  const flag = (file: string, value: LibraryValue): ConfigMemberItem => ({ kind: 'setting', id: 'setting:flag', group: 'settings', place: 'member', file, format: 'json', keyPath: ['plugins', 'claude-mem'], value, whenUnrecorded: 'replace-and-stash' });

  it('a recorded member the user edited is left on remove', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    applyLibrary({ agentId: 'agent', items: [flag(file, true)], ownedGroups: ['settings'] }, context);
    writeFileSync(file, read(file).replace('"claude-mem": true', '"claude-mem": "mine now"'));
    const result = removeLibrary({ agentId: 'agent', items: [flag(file, true)] }, context);
    expect(result.items[0].outcome).toBe('left-to-user');
    expect(JSON.parse(read(file)).plugins['claude-mem']).toBe('mine now');
  });

  it('a recorded member the user edited is not overwritten by a sync', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    applyLibrary({ agentId: 'agent', items: [flag(file, true)], ownedGroups: ['settings'] }, context);
    writeFileSync(file, read(file).replace('"claude-mem": true', '"claude-mem": "mine now"'));
    const sync = applyLibrary({ agentId: 'agent', items: [flag(file, { version: 2 })], ownedGroups: ['settings'] }, context);
    expect(sync.items[0].outcome).toBe('left-to-user');
    expect(JSON.parse(read(file)).plugins['claude-mem']).toBe('mine now');
  });

  it('an instruction block the user edited is left on remove', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'AGENTS.md');
    const block: TextBlockItem = { kind: 'instructions', id: 'instructions', group: 'instructions', place: 'text-block', file, open: '<!-- cm:begin -->', close: '<!-- cm:end -->', body: 'Use memory.', placement: 'after-trimmed-text' };
    writeFileSync(file, '# Mine\n');
    applyLibrary({ agentId: 'agent', items: [block], ownedGroups: ['instructions'] }, context);
    const edited = read(file).replace('Use memory.', 'Use memory, my way.');
    writeFileSync(file, edited);
    const result = removeLibrary({ agentId: 'agent', items: [block] }, context);
    expect(result.items[0].outcome).toBe('left-to-user');
    expect(read(file)).toBe(edited);
  });

  it('an entry equal to claude-mem\'s but without its signature is the user\'s on apply and on remove', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    const item: JsonArrayEntryItem = { ...hookItem(file, 'cm stop'), isPreLibraryEntry: (entry) => (entry as { managedBy?: unknown }).managedBy === 'claude-mem' };
    writeFileSync(file, JSON.stringify({ hooks: { stop: [{ command: 'cm stop' }] } }, null, 2) + '\n');
    expect(applyLibrary({ agentId: 'agent', items: [item], ownedGroups: ['hooks'] }, context).items[0].outcome).toBe('left-to-user');
    removeLibrary({ agentId: 'agent', items: [item] }, context);
    expect(JSON.parse(read(file)).hooks.stop).toEqual([{ command: 'cm stop' }]);
  });
});

describe('Library engine: unparseable TOML and YAML are never written', () => {
  for (const [format, name, bytes] of [['toml', 'config.toml', 'model = = "o3"\n'], ['yaml', 'config.yaml', 'extensions:\n  - a\n  b: [\n']] as const) {
    it(`refuses ${format}`, () => {
      const { dir, context } = sandbox();
      const file = join(dir, name);
      writeFileSync(file, bytes);
      const item: ConfigMemberItem = { kind: 'mcp', id: 'mcp', group: 'mcp', place: 'member', file, format, keyPath: ['extensions', 'claude-mem'], value: { cmd: 'node' }, whenUnrecorded: 'adopt' };
      expect(() => applyLibrary({ agentId: 'agent', items: [item], ownedGroups: ['mcp'] }, context)).toThrow(`is not ${format.toUpperCase()} claude-mem can read`);
      expect(read(file)).toBe(bytes);
      expect(readLibraryRecords(context.libraryDirectory).agent).toBeUndefined();
    });
  }
});

describe('Library engine: uninstall after an upgrade from a pre-Library install (P1)', () => {
  it('a block an older install left between claude-mem\'s markers is gone after remove, not put back', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'config.toml');
    const block = (body: string): TextBlockItem => ({ kind: 'hook', id: 'hook:block', group: 'hooks', place: 'text-block', file, open: '# >>> cm', close: '# <<< cm', body, placement: 'after-blank-line', validateAs: 'toml' });
    writeFileSync(file, 'model = "k2"\n\n# >>> cm\n[[hooks]]\ncommand = "/dead/path"\n# <<< cm\n');
    applyLibrary({ agentId: 'agent', items: [block('[[hooks]]\ncommand = "/new/path"')], ownedGroups: ['hooks'] }, context);
    expect(read(file)).not.toContain('/dead/path');
    // Recorded at the first write: these earlier bytes are never to be put back whole.
    expect(readLibraryRecords(context.libraryDirectory).agent.files[file].exactRestore).toBe(false);
    removeLibrary({ agentId: 'agent', items: [block('[[hooks]]\ncommand = "/new/path"')] }, context);
    expect(read(file)).not.toContain('# >>> cm');
    expect(read(file)).not.toContain('/dead/path');
    expect(read(file)).toContain('model = "k2"');
  });

  it('a value claude-mem itself left before the record is not what a remove puts back', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ plugins: { 'claude-mem': true, other: true } }, null, 2) + '\n');
    const offWhenRemoved: ConfigMemberItem = { kind: 'setting', id: 'on', group: 'settings', place: 'member', file, format: 'json', keyPath: ['plugins', 'claude-mem'], value: true, whenUnrecorded: 'replace-and-stash', isPreLibraryValue: (value) => value === true, valueAfterRemoveOfPreLibraryValue: false };
    applyLibrary({ agentId: 'agent', items: [offWhenRemoved], ownedGroups: ['settings'] }, context);
    removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(JSON.parse(read(file)).plugins).toEqual({ 'claude-mem': false, other: true });

    // Without a value for after the remove, the key goes.
    const second = sandbox();
    const other = join(second.dir, 'settings.json');
    writeFileSync(other, JSON.stringify({ slot: 'claude-mem', theme: 'dark' }, null, 2) + '\n');
    const slot: ConfigMemberItem = { kind: 'setting', id: 'slot', group: 'settings', place: 'member', file: other, format: 'json', keyPath: ['slot'], value: 'claude-mem', whenUnrecorded: 'replace-and-stash', isPreLibraryValue: (value) => value === 'claude-mem' };
    applyLibrary({ agentId: 'agent', items: [slot], ownedGroups: ['settings'] }, second.context);
    removeLibrary({ agentId: 'agent', items: [] }, second.context);
    expect(JSON.parse(read(other))).toEqual({ theme: 'dark' });
  });

  it('a file an older install copied to claude-mem\'s own path is removed, not restored', () => {
    const { dir, context } = sandbox();
    const root = join(dir, 'extensions', 'claude-mem');
    const path = join(root, 'index.js');
    mkdirSync(root, { recursive: true });
    writeFileSync(path, 'old build');
    const item: OwnedFileItem = { kind: 'bundle', id: 'bundle:index.js', group: 'bundle', place: 'file', path, contents: new TextEncoder().encode('new build'), bundleRoot: root };
    applyLibrary({ agentId: 'agent', items: [item], ownedGroups: ['bundle'] }, context);
    removeLibrary({ agentId: 'agent', items: [] }, context);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it('a record that would restore claude-mem\'s old entries whole is checked by their signatures first', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    writeFileSync(file, JSON.stringify({ hooks: { stop: [{ command: './mine.sh' }] } }, null, 2) + '\n');
    applyLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')], ownedGroups: ['hooks'] }, context);
    // As a record from before this fix holds it: the bytes before claude-mem carried an old claude-mem hook.
    const recordPath = libraryRecordPath(context.libraryDirectory);
    const recordFile = JSON.parse(read(recordPath));
    recordFile.agents.agent.files[file].bytesBeforeBase64 = Buffer.from(JSON.stringify({ hooks: { stop: [{ command: './mine.sh' }, { command: 'cm old' }] } }, null, 2) + '\n').toString('base64');
    writeFileSync(recordPath, JSON.stringify(recordFile));
    removeLibrary({ agentId: 'agent', items: [hookItem(file, 'cm stop')] }, context);
    expect(JSON.parse(read(file)).hooks.stop).toEqual([{ command: './mine.sh' }]);
  });

  it('a file with nothing of claude-mem\'s before still gets its exact bytes back', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    const original = '{"theme":"dark"}';
    writeFileSync(file, original);
    const slot: ConfigMemberItem = { kind: 'setting', id: 'slot', group: 'settings', place: 'member', file, format: 'json', keyPath: ['slot'], value: 'claude-mem', whenUnrecorded: 'replace-and-stash', isPreLibraryValue: (value) => value === 'claude-mem' };
    applyLibrary({ agentId: 'agent', items: [slot], ownedGroups: ['settings'] }, context);
    removeLibrary({ agentId: 'agent', items: [slot] }, context);
    expect(read(file)).toBe(original);
  });
});

describe('Library engine: a change is crash-safe (P2)', () => {
  const flag = (file: string): ConfigMemberItem => ({ kind: 'setting', id: 'setting:flag', group: 'settings', place: 'member', file, format: 'json', keyPath: ['plugins', 'claude-mem'], value: true, whenUnrecorded: 'replace-and-stash' });
  /** How long the crashing child may take: it starts Bun and makes one change, well under a second; the bound reports a hang. */
  const CRASH_CHILD_TIMEOUT_MS = 30_000;

  it('a throw after the files are written puts every file back and records nothing', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    const original = JSON.stringify({ theme: 'dark' }, null, 2) + '\n';
    writeFileSync(file, original);
    expect(() => applyLibrary({ agentId: 'agent', items: [flag(file)], ownedGroups: ['settings'] }, { ...context, afterConfigFilesWritten: () => { throw new Error('disk full'); } })).toThrow('disk full');
    expect(read(file)).toBe(original);
    const recordFile = JSON.parse(read(libraryRecordPath(context.libraryDirectory)));
    expect(recordFile.agents.agent).toBeUndefined();
    expect(recordFile.pendingChange).toBeUndefined();
  });

  it('a crash after the files are written is rolled back by the next command, so the value the user had stays theirs', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'settings.json');
    const original = JSON.stringify({ theme: 'dark' }, null, 2) + '\n';
    writeFileSync(file, original);
    const child = spawnSync(process.execPath, [join(import.meta.dir, 'library', 'crash-mid-change.ts'), context.libraryDirectory, file], { encoding: 'utf-8', timeout: CRASH_CHILD_TIMEOUT_MS });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 86, stderr: '' });
    // As the crash left it: the file written, library.json holding the change as pending.
    expect(JSON.parse(read(file)).plugins['claude-mem']).toBe(true);
    const recordPath = libraryRecordPath(context.libraryDirectory);
    const pendingChange = JSON.parse(read(recordPath)).pendingChange;
    expect(pendingChange.files.map((entry: { path: string }) => entry.path)).toEqual([file]);
    // The crashed holder's lock is stale by now (FILE_LOCK_STALE_MS).
    const lockPath = `${recordPath}.lock`;
    if (existsSync(lockPath)) utimesSync(lockPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    const recovered = applyLibrary({ agentId: 'agent', items: [flag(file)], ownedGroups: ['settings'] }, context);
    expect(recovered.recoveryNotes).toEqual([`${file}: put back as it was before an interrupted claude-mem Library change (agent, ${pendingChange.at})`]);
    expect(readLibraryRecords(context.libraryDirectory).agent.settings[0].previous).toEqual({ absent: true });
    expect(JSON.parse(read(recordPath)).pendingChange).toBeUndefined();
    removeLibrary({ agentId: 'agent', items: [flag(file)] }, context);
    expect(read(file)).toBe(original);
  });
});

describe('Library engine: JSONC arrays keep their comments (P2)', () => {
  it('adds and removes a hook as one element: the user\'s comments and formatting inside the array survive', () => {
    const { dir, context } = sandbox();
    const file = join(dir, 'hooks.json');
    const original = `{
  // my cursor hooks
  "version": 1,
  "hooks": {
    "stop": [
      // keep: user's notifier
      { "command": "notify-send done" }, // trailing note
    ],
    "afterFileEdit": [{ "command": "prettier --write" }]
  }
}
`;
    writeFileSync(file, original);
    const items = [hookItem(file, 'cm summarize', 'stop'), hookItem(file, 'cm edit', 'afterFileEdit')];
    applyLibrary({ agentId: 'agent', items, ownedGroups: ['hooks'] }, context);
    const written = read(file);
    expect(written).toContain('      // keep: user\'s notifier\n      { "command": "notify-send done" }, // trailing note\n');
    expect(written).toContain('[{ "command": "prettier --write" }, {"command":"cm edit"}]');
    expect(JSON.parse(written.replace(/\/\/.*$/gm, '').replace(/,(\s*[\]}])/g, '$1')).hooks.stop).toEqual([{ command: 'notify-send done' }, { command: 'cm summarize' }]);

    // The user edits elsewhere, so the remove takes out only claude-mem's elements (no exact restore).
    writeFileSync(file, read(file).replace('"prettier --write"', '"prettier --write --cache"'));
    removeLibrary({ agentId: 'agent', items }, context);
    expect(read(file)).toBe(original.replace('"prettier --write"', '"prettier --write --cache"'));
  });
});
