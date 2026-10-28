import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { bucketFileAvailable, copyCoversSource, fileKind, isLocalPath, mergeProducts, productsFromDeliverable, productsFromFields, productsFromObservation, productsFromToolUse, recordedFile } from '../../../src/services/work-view/work-product.mjs';
import { buildHumanRequests } from '../../../src/services/work-view/request-projection.mjs';

const call = (extra) => ({ id: 5, session_db_id: 7, prompt_number: 1, created_at_epoch: 100, ...extra });

test('an Artifact publish records its link and title; list and read calls record nothing', () => {
  const published = productsFromToolUse(call({ tool_name: 'Artifact', tool_input: JSON.stringify({ file_path: '/w/deck.html', title: 'Launch deck' }), tool_response: JSON.stringify({ url: 'https://claude.ai/artifact/abc', title: 'Launch deck' }) }));
  assert.deepEqual(published, [{ kind: 'artifact', title: 'Launch deck', url: 'https://claude.ai/artifact/abc', atEpoch: 100, sourceRef: { kind: 'tool-use', id: 5 } }]);
  assert.deepEqual(productsFromToolUse(call({ tool_name: 'Artifact', tool_input: JSON.stringify({ action: 'list' }), tool_response: JSON.stringify({ artifacts: [{ url: 'https://claude.ai/artifact/x' }] }) })), []);
});

test('gh pr create records the pull request URL and its title', () => {
  const [product] = productsFromToolUse(call({ tool_name: 'Bash', tool_input: JSON.stringify({ command: 'git push && rtk gh pr create --title "Add work product" --body x' }), tool_response: JSON.stringify({ stdout: 'https://github.com/o/r/pull/42\n' }) }));
  assert.equal(product.kind, 'pull-request');
  assert.equal(product.url, 'https://github.com/o/r/pull/42');
  assert.equal(product.title, 'Add work product');
  const searched = call({ tool_name: 'Bash', tool_input: JSON.stringify({ command: `sqlite3 db "select * from tool_uses where tool_input like '%gh pr create%'"` }), tool_response: JSON.stringify({ stdout: 'x|https://github.com/o/r/pull/7', gitOperation: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', action: 'created' } } }) });
  assert.deepEqual(productsFromToolUse(searched), []);
});

test('observers record only human-facing files, with their position in the list', () => {
  const products = productsFromObservation({ id: 9, files_modified: JSON.stringify(['/w/src/app.ts', '/w/design/pass-01.png', '/w/report.html']), created_at_epoch: 50 });
  assert.deepEqual(products.map((product) => [product.kind, product.title, product.sourceRef.index]), [['image', 'pass-01.png', 1], ['page', 'report.html', 2]]);
  assert.equal(fileKind('relative/x.png'), null);
  assert.equal(fileKind('/w/../etc/x.png'), null);
});

test('work_product fields attach links and files; unsafe URLs are dropped', () => {
  const products = productsFromFields({
    work_product: [{ title: 'Q4 deck', url: 'https://docs.google.com/presentation/d/1' }, { path: '/w/out/hero.png' }, 'javascript:alert(1)'],
    docs_url: 'https://docs.example.com/guide', status: 'done',
  }, { atEpoch: 3, sourceRef: { kind: 'work-state', id: 11 } });
  assert.deepEqual(products.map((product) => [product.kind, product.title, product.field, product.sourceRef.index]), [
    ['link', 'Q4 deck', 'work_product', 0], ['image', 'hero.png', 'work_product', 1], ['documentation', 'docs.example.com', 'docs_url', 3],
  ]);
});

test('several work products with titles arrive as one JSON string field', () => {
  const products = productsFromFields({ work_product: JSON.stringify([{ title: 'Q4 deck', url: 'https://docs.google.com/presentation/d/1' }, { path: '/w/out/hero.png' }]) });
  assert.deepEqual(products.map((product) => [product.kind, product.title]), [['link', 'Q4 deck'], ['image', 'hero.png']]);
  assert.deepEqual(productsFromFields({ work_product: '/w/out/report.pdf' }).map((product) => product.title), ['report.pdf']);
});

test('local paths are absolute for the platform, with no .. part', () => {
  assert.equal(isLocalPath('C:\\work\\hero.png', win32.isAbsolute), true);
  assert.equal(isLocalPath('C:/work/report.pdf', win32.isAbsolute), true);
  assert.equal(isLocalPath('C:\\work\\..\\secret.png', win32.isAbsolute), false);
  assert.equal(isLocalPath('work\\hero.png', win32.isAbsolute), false);
  assert.equal(isLocalPath('/w/out/hero.png', posix.isAbsolute), true);
  assert.equal(isLocalPath('C:\\work\\hero.png', posix.isAbsolute), false);
});

test('merging keeps the newest entry for each link or file', () => {
  const merged = mergeProducts([[{ url: 'https://a', atEpoch: 1, title: 'old' }], [{ url: 'https://a', atEpoch: 2, title: 'new' }, { path: '/b.png', atEpoch: 0 }]]);
  assert.deepEqual(merged.map((product) => product.title ?? product.path), ['new', '/b.png']);
});

test('a request collects work product from its conversation only', () => {
  const sessions = [
    { id: 7, platform_source: 'claude', content_session_id: 'c-7', memory_session_id: 'm-7', user_prompt: 'Build the launch deck.', started_at_epoch: 1 },
    { id: 8, platform_source: 'claude', content_session_id: 'c-8', memory_session_id: 'm-8', user_prompt: 'Fix the login bug.', started_at_epoch: 1 },
  ];
  const agents = sessions.map((session) => ({ id: `a${session.id}`, label: 'Claude Code', sessionId: session.id, work: [{ id: session.id, title: 'work', kind: 'work-state', listId: `l${session.id}`, listName: 'l', project: 'p', lastUpdateEpoch: 5 }] }));
  const { humanRequests } = buildHumanRequests({ agents }, {
    sessions, prompts: [],
    productCalls: [call({ tool_name: 'Artifact', tool_input: '{}', tool_response: JSON.stringify({ url: 'https://claude.ai/artifact/deck', title: 'Deck' }) })],
    productObservations: [{ id: 3, memory_session_id: 'm-8', files_modified: JSON.stringify(['/nowhere/fix.png']), created_at_epoch: 9 }],
  });
  const deck = humanRequests.find((request) => request.original.text === 'Build the launch deck.');
  const fix = humanRequests.find((request) => request.original.text === 'Fix the login bug.');
  assert.deepEqual(deck.workProduct.map((product) => product.url), ['https://claude.ai/artifact/deck']);
  assert.equal(fix.workProduct[0].fileUrl, '/api/work-view/file/observation/3/0');
  assert.equal(fix.workProduct[0].available, false);
});

test('the file route resolves only a file its record names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-product-'));
  try {
    const image = join(dir, 'shot.png');
    writeFileSync(image, 'png');
    const rows = { observation: { id: 4, files_modified: JSON.stringify(['/w/a.ts', image]), created_at_epoch: 1 } };
    const read = (sql) => /FROM observations/.test(sql) ? [rows.observation] : [];
    assert.equal(recordedFile(read, 'observation', 4, 1), image);
    assert.equal(recordedFile(read, 'observation', 4, 0), null);
    assert.equal(recordedFile(read, 'session', 4, 1), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a bucket copy links the request to the deliverables route and replaces the record of the file it was copied from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-deliverable-'));
  const bucketPath = join(dir, 'report-3f9a1c2b.html');
  writeFileSync(bucketPath, '<h1>Launch report</h1>');
  const sessions = [{ id: 7, platform_source: 'claude', content_session_id: 'c-7', memory_session_id: 'm-7', user_prompt: 'Write the launch report.', started_at_epoch: 1 }];
  const agents = sessions.map((session) => ({ id: `a${session.id}`, label: 'Claude Code', sessionId: session.id, work: [{ id: session.id, title: 'work', kind: 'work-state', listId: `l${session.id}`, listName: 'l', project: 'p', lastUpdateEpoch: 5 }] }));
  const row = { id: 21, project: 'p', content_session_id: 'c-7', platform_source: 'claude', title: 'Launch report', kind: 'page', source_path: '/w/.scratch/report.html', bucket_path: bucketPath, created_at_epoch: 12 };
  const records = {
    sessions, prompts: [], productCalls: [],
    productObservations: [{ id: 3, memory_session_id: 'm-7', files_modified: JSON.stringify(['/w/.scratch/report.html', '/w/design/hero.png']), created_at_epoch: 9 }],
    productDeliverables: [row, { id: 22, project: 'p', content_session_id: 'c-other', platform_source: 'claude', title: 'Elsewhere', kind: 'page', source_path: '/x.html', bucket_path: bucketPath, created_at_epoch: 13 }],
  };
  const [request] = buildHumanRequests({ agents }, records).humanRequests;
  assert.deepEqual(request.workProduct.map((product) => [product.kind, product.title, product.url ?? product.fileUrl, product.available, product.deliverable ?? false]), [
    ['page', 'Launch report', '/api/deliverables/21/report-3f9a1c2b.html', true, true],
    ['image', 'hero.png', '/api/work-view/file/observation/3/1', false, false],
  ]);
  assert.deepEqual(request.workProduct[0].sourceRef, { kind: 'deliverable', id: 21 });

  rmSync(dir, { recursive: true, force: true });
  // With the copy gone, the record of where the file was made is shown again (unavailable too, here: the source is gone).
  const [later] = buildHumanRequests({ agents }, records).humanRequests;
  assert.deepEqual(later.workProduct.map((product) => [product.title, product.available, product.deliverable ?? false]), [
    ['Launch report', false, true], ['report.html', false, false], ['hero.png', false, false],
  ]);
  assert.equal(bucketFileAvailable({ bucketPath }), false);
  assert.deepEqual(productsFromDeliverable({ id: 0, bucket_path: '/x' }), []);
  assert.deepEqual(productsFromDeliverable({ id: 5, bucket_path: '' }), []);
  assert.equal(productsFromDeliverable({ id: 5, bucket_path: '/b/notes-abcdef12.md', title: '' })[0].title, 'notes-abcdef12.md');
  assert.equal(productsFromDeliverable({ id: 5, bucket_path: '/b/notes-abcdef12.md' })[0].kind, 'file');
});

test('a bucket copy covers the source record only while it is on disk and the source has not been written since', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-deliverable-cover-'));
  try {
    const bucketPath = join(dir, 'report-3f9a1c2b.html');
    const sourcePath = join(dir, 'report.html');
    writeFileSync(bucketPath, '<h1>v1</h1>');
    writeFileSync(sourcePath, '<h1>v1</h1>');
    const copiedAt = Date.now();
    const copy = { deliverable: true, bucketPath, sourcePath, atEpoch: copiedAt };
    // Written before the copy: covered.
    utimesSync(sourcePath, new Date(copiedAt - 60_000), new Date(copiedAt - 60_000));
    assert.equal(copyCoversSource(copy, sourcePath), true);
    // Revised after the copy: a newer version, shown beside the copy.
    utimesSync(sourcePath, new Date(copiedAt + 60_000), new Date(copiedAt + 60_000));
    assert.equal(copyCoversSource(copy, sourcePath), false);
    // The source is gone: the copy is all that is left of it.
    rmSync(sourcePath);
    assert.equal(copyCoversSource(copy, sourcePath), true);
    // No copy on disk, or no time for it: nothing is hidden.
    assert.equal(copyCoversSource({ ...copy, bucketPath: join(dir, 'missing.html') }, sourcePath), false);
    assert.equal(copyCoversSource({ ...copy, atEpoch: null }, sourcePath), false);

    // Through the projection: an observation of a file revised after its copy stays on the card as the newer version.
    writeFileSync(sourcePath, '<h1>v2</h1>');
    utimesSync(sourcePath, new Date(copiedAt + 60_000), new Date(copiedAt + 60_000));
    const sessions = [{ id: 7, platform_source: 'claude', content_session_id: 'c-7', memory_session_id: 'm-7', user_prompt: 'Write the launch report.', started_at_epoch: 1 }];
    const agents = sessions.map((session) => ({ id: `a${session.id}`, label: 'Claude Code', sessionId: session.id, work: [{ id: session.id, title: 'work', kind: 'work-state', listId: `l${session.id}`, listName: 'l', project: 'p', lastUpdateEpoch: 5 }] }));
    const records = {
      sessions, prompts: [], productCalls: [],
      productObservations: [{ id: 3, memory_session_id: 'm-7', files_modified: JSON.stringify([sourcePath]), created_at_epoch: copiedAt + 90_000 }],
      productDeliverables: [{ id: 21, project: 'p', content_session_id: 'c-7', platform_source: 'claude', title: 'Launch report', kind: 'page', source_path: sourcePath, bucket_path: bucketPath, created_at_epoch: copiedAt }],
    };
    const [revised] = buildHumanRequests({ agents }, records).humanRequests;
    assert.deepEqual(revised.workProduct.map((product) => [product.title, product.available, product.deliverable ?? false]), [
      ['report.html', true, false], ['Launch report', true, true],
    ]);
    utimesSync(sourcePath, new Date(copiedAt - 60_000), new Date(copiedAt - 60_000));
    const [unchanged] = buildHumanRequests({ agents }, records).humanRequests;
    assert.deepEqual(unchanged.workProduct.map((product) => product.title), ['Launch report']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
