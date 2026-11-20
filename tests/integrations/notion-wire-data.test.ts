import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchEnd, buildNotionChildren, buildNotionProperties, loadOrCreateNotionSourceId, normalizeNotionId, NotionExporter } from '../../src/services/integrations/NotionExporter.js';

const observation = { type: 'discovery', title: 'note', subtitle: null, narrative: '',
  facts: [], concepts: [], files_read: [], files_modified: [] } as any;
const row = { observationId: 1, project: 'p', memorySessionId: 's', createdAtEpoch: 1000, observation };

test('rich text boundaries never send isolated surrogate code units', () => {
  const title = 'x'.repeat(1999) + '🌉 complete';
  const p = buildNotionProperties({ ...row, observation: { ...observation, title } }, 'Name', 'install') as any;
  assert.ok(p.Name.title.every((part: any) => part.text.content.isWellFormed()));
  assert.equal(p.Name.title.map((part: any) => part.text.content).join(''), title);
});

test('Windows paragraph breaks produce the same block structure as Unix breaks', () => {
  const blocks = (narrative: string) => buildNotionChildren({ ...observation, narrative });
  assert.deepEqual(blocks('one\r\n\r\ntwo'), blocks('one\n\ntwo'));
});

test('a damaged install identity cannot deduplicate unrelated devices against an empty prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion-source-id-'));
  try {
    const path = join(dir, 'id');
    writeFileSync(path, ' \n');
    assert.throws(() => loadOrCreateNotionSourceId(path), (error: Error) =>
      /empty/i.test(error.message) && error.message.includes(path));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mistyped longer database identifier is not truncated to a different destination', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.equal(normalizeNotionId('f' + id), null);
  assert.equal(normalizeNotionId('https://www.notion.so/team/Page-' + id + '?view=other'), normalizeNotionId(id));
  for (const schemeless of ['www.notion.so/team/Page-' + id, 'notion.so/' + id + '?v=1', 'team.notion.site/Page-' + id]) {
    assert.equal(normalizeNotionId(schemeless), normalizeNotionId(id), schemeless);
  }
  assert.equal(normalizeNotionId('www.notion.so/team/Page-f' + id), null);
});

test('an entry that alone exceeds the request limit fails instead of looping without progress', () => {
  assert.throws(() => batchEnd(['x'.repeat(600_000)], 0, { children: [] }), /exceeds the request limit/);
  assert.equal(batchEnd(['small'], 0, { children: [] }), 1);
  assert.equal(batchEnd([], 0, { children: [] }), 0);
});

async function assertLongParagraphExport(subtitle: string | null): Promise<void> {
  const writes: any[] = [];
  let creates = 0;
  const exporter = new NotionExporter({ token: 'test', databaseId: 'db', sourceId: 'source',
    autoCreateProperties: false, minRequestIntervalMs: 0,
    fetchImpl: async (url, init) => {
      if (init.method === 'GET') return Response.json({ properties: { Name: { type: 'title' }, Subtitle: { type: 'rich_text' } } });
      assert.ok(url.endsWith('/pages') || url.endsWith('/blocks/page/children'));
      const body = String(init.body);
      assert.ok(Buffer.byteLength(body) <= 500_000, 'serialized JSON exceeds 500 KB');
      const { children } = JSON.parse(body);
      assert.ok(children.length <= 100);
      if (init.method === 'POST') {
        creates++;
        assert.equal(children.length === 0, subtitle !== null, 'only defer the first block when it cannot fit');
      } else {
        assert.equal(creates, 1);
        assert.ok(children.length > 0);
      }
      writes.push(...children);
      return Response.json({ id: 'page' });
    } });
  const narrative = '戦'.repeat(510_000);
  assert.equal(await exporter.upsert({ ...row, observation: { ...observation, narrative, subtitle } }), 'created');
  assert.equal(creates, 1);
  assert.equal(writes.flatMap(b => b.paragraph.rich_text.map((t: any) => t.text.content)).join(''), narrative);
}

test('multibyte long paragraphs fit the wire budget across page creation and appends', () => assertLongParagraphExport(null));
test('a block too large for page creation is appended to the empty page', () => assertLongParagraphExport('s'.repeat(10_000)));

for (const { label, title, characters } of [
  { label: 'a writable multibyte subtitle', title: 'note', characters: 170_000 },
  { label: 'a subtitle shared with the title fallback', title: null, characters: 100_000 },
]) {
  test(`${label} fits the create budget without changing the export key`, async () => {
    const subtitle = '戦'.repeat(characters);
    const exporter = new NotionExporter({ token: 'test', databaseId: 'db', sourceId: 'source',
      autoCreateProperties: false, minRequestIntervalMs: 0,
      fetchImpl: async (url, init) => {
        if (init.method === 'GET') return Response.json({ properties: {
          Name: { type: 'title' }, Subtitle: { type: 'rich_text' }, 'Export Key': { type: 'rich_text' },
        } });
        if (url.endsWith('/query')) return Response.json({ results: [] });
        assert.ok(url.endsWith('/pages'));
        const body = String(init.body);
        assert.ok(Buffer.byteLength(body) <= 500_000, 'create exceeds 500 KB');
        const { properties } = JSON.parse(body);
        const retained = properties.Subtitle.rich_text.map((part: any) => part.text.content).join('');
        assert.ok(retained.length > 0 && retained.length < subtitle.length && subtitle.startsWith(retained));
        const pageTitle = properties.Name.title.map((part: any) => part.text.content).join('');
        if (title) assert.equal(pageTitle, title);
        else assert.ok(pageTitle.length > 0 && subtitle.startsWith(pageTitle));
        assert.equal(properties['Export Key'].rich_text[0].text.content, 'source:1');
        return Response.json({ id: 'page' });
      } });
    assert.equal(await exporter.upsert({ ...row, observation: { ...observation, title, subtitle } }), 'created');
  });
}
