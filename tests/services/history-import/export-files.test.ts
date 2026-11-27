import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readExportFiles } from '../../../src/services/history-import/export-files.js';
import { zipOf } from '../../helpers/fake-conda-package.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cmem-export-reader-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function read(path: string) {
  const files = [];
  for await (const file of readExportFiles(path)) files.push(file);
  return files;
}

describe('historical export file selection', () => {
  it('streams selected, deflated JSON entries in catalog-first order without opening attachments', async () => {
    const archive = join(root, 'export.zip');
    const bytes = zipOf({
      'data/conversations-001.json': Buffer.from('[1]'),
      'data/conversations-000.json': Buffer.from('[0]'),
      'data/projects/p1.json': Buffer.from('{"uuid":"p1"}'),
      'data/unrelated.jsonl': Buffer.from('not JSON'),
      'data/files/conversations.json': Buffer.from('not JSON'),
      'data/chat.html': Buffer.from('not JSON'),
    }, ['data/conversations-001.json']);
    await writeFile(archive, bytes);
    expect(await read(archive)).toEqual([
      {name: 'projects/p1.json', value: {uuid: 'p1'}},
      {name: 'conversations-000.json', value: [0]},
      {name: 'conversations-001.json', value: [1]},
    ]);
  });

  it.each(['', 'work/'])('reads native JSONL from the archive root or one wrapper (%s)', async prefix => {
    const archive = join(root, 'native.zip');
    await writeFile(archive, zipOf({
      [prefix + 'session.jsonl']: Buffer.from('{"type":"session_meta"}\n{}\n'),
      [prefix + 'subagents/session.jsonl']: Buffer.from('invalid'),
      [prefix + 'attachments/input.jsonl']: Buffer.from('invalid'),
    }, [prefix + 'session.jsonl']));
    expect(await read(archive)).toEqual([{name: 'session.jsonl', value: [{type: 'session_meta'}, {}]}]);
  });

  it('never selects a directory containing only subagent logs as an export root', async () => {
    const archive = join(root, 'subagents.zip');
    await writeFile(archive, zipOf({'subagents/private.jsonl': Buffer.from('{}')}));
    await expect(read(archive)).rejects.toThrow('No conversations JSON or root-level JSONL');
  });

  it('reads only the chosen conversations shard and neighboring project metadata', async () => {
    await writeFile(join(root, 'conversations-001.json'), '[]');
    await writeFile(join(root, 'conversations-000.json'), '[]');
    await writeFile(join(root, 'projects.json'), '[]');
    await writeFile(join(root, 'users.json'), 'not JSON');
    expect((await read(join(root, 'conversations-001.json'))).map(f => f.name))
      .toEqual(['projects.json', 'conversations-001.json']);
    expect((await read(root)).map(f => f.name)).toEqual(['projects.json','conversations-000.json','conversations-001.json']);
  });

  it('reads selected native JSONL and skips unrelated nested folders', async () => {
    await writeFile(join(root, 'sample.jsonl'), '\uFEFF{}\r\n\n{"n":1}\n');
    await mkdir(join(root, 'subagents'));
    await writeFile(join(root, 'subagents', 'private.jsonl'), 'invalid');
    expect(await read(root)).toEqual([{name: 'sample.jsonl', value: [{},{n: 1}]}]);
    expect(await read(join(root, 'sample.jsonl'))).toEqual(await read(root));
  });

  it('reports malformed input without including private JSON fragments in errors', async () => {
    const file = join(root, 'sample.json');
    await writeFile(file, 'DO_NOT_ECHO_PRIVATE_TEXT');
    await expect(read(file)).rejects.toThrow(/^Invalid JSON in sample\.json\.$/);
  });

  it('rejects an oversized compressed entry before decompression', async () => {
    const archive = join(root, 'large.zip');
    const bytes = zipOf({'conversations.json': Buffer.from('[]')}, ['conversations.json']);
    const index = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0x40000000, index + 24);
    await writeFile(archive, bytes);
    await expect(read(archive)).rejects.toThrow('too large');
  });
});
