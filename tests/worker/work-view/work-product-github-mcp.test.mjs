import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { productsFromToolUse, readProductRecords } from '../../../src/services/work-view/work-product.mjs';

// GitHub's official MCP server returns { id, url } in text content and
// { id, html_url } in structuredContent after creation. An unsubmitted UI form
// instead returns status: awaiting_user_submission.
// github/github-mcp-server@6fbcd00b2034502ba3001a49dfaf93593aee7069:
// pkg/github/pullrequests.go and pkg/github/consolidated_pull_request_types.go.
const URL = 'https://github.com/owner/project/pull/42';
const INPUT = { owner: 'owner', repo: 'project', title: 'Preserve completed work', head: 'fix', base: 'main' };
const call = (response, { tool = 'mcp__github__create_pull_request', input = INPUT, id = 12 } = {}) => ({
  id, session_db_id: 7, prompt_number: 1, tool_name: tool, tool_input: JSON.stringify(input),
  tool_response: JSON.stringify(response), created_at_epoch: 100,
});

test('a completed GitHub MCP create records its returned pull request and source', () => {
  expect(productsFromToolUse(call({ id: '123456', url: URL }))).toEqual([{
    kind: 'pull-request', title: INPUT.title, url: URL, atEpoch: 100, sourceRef: { kind: 'tool-use', id: 12 },
  }]);
});

test('GitHub text and structured MCP result envelopes identify the same created pull request', () => {
  const text = { type: 'text', text: JSON.stringify({ id: '123456', url: URL }) };
  for (const response of [
    [text], { content: [text] }, { structuredContent: { id: '123456', html_url: URL } },
    { content: [text], structuredContent: { id: '123456', html_url: URL } },
  ]) {
    const products = productsFromToolUse(call(response, { tool: 'create_pull_request' }));
    expect(products).toHaveLength(1);
    expect(products[0].url).toBe(URL);
  }
});

test('only a completed result for the requested repository counts as a publication', () => {
  const valid = { id: '123456', html_url: URL };
  for (const response of [
    { isError: true, structuredContent: valid },
    { status: 'awaiting_user_submission', ...valid },
    { structuredContent: { status: 'awaiting_user_submission' }, content: [{ type: 'text', text: JSON.stringify(valid) }] },
    { error: 'Creation failed', ...valid },
    { content: [{ type: 'text', text: `Existing pull request: ${URL}` }] },
    { id: '123456', html_url: 'https://github.com/another/project/pull/42' },
    { id: '123456', html_url: 'https://github.com/owner/different/pull/42' },
    { id: '123456', html_url: 'https://github.com.evil.invalid/owner/project/pull/42' },
    { id: '123456', html_url: 'https://user:password@github.com/owner/project/pull/42' },
    { id: '123456', html_url: 'https://api.github.com/repos/owner/project/pulls/42' },
    { id: '123456', html_url: 'https://github.com/owner/project/issues/42' },
    { id: '123456', html_url: URL, number: 43 },
    { id: { toString: 'unreadable' }, html_url: URL },
    { id: '123456', html_url: URL, number: { toString: 'unreadable' } },
    { content: [{ type: 'text', text: valid }] },
    { html_url: URL },
  ]) expect(productsFromToolUse(call(response))).toEqual([]);
  for (const tool of ['mcp__github__pull_request_read', 'mcp__github__create_pull_request_preview']) {
    expect(productsFromToolUse(call(valid, { tool }))).toEqual([]);
  }
});

test('the product query discovers completed MCP creation calls without collecting reads or lookalikes', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER,
      tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER);
      CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, prompt_number INTEGER, files_modified TEXT, created_at_epoch INTEGER);
      CREATE TABLE deliverables (id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT, platform_source TEXT,
        title TEXT, kind TEXT, source_path TEXT, bucket_path TEXT, created_at_epoch INTEGER);`);
    const insert = db.prepare('INSERT INTO tool_uses VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [index, tool] of ['create_pull_request', 'mcp__github__create_pull_request', 'mcp__github__pull_request_read', 'mcp__github__create_pull_request_preview'].entries()) {
      const row = call({ id: '123456', url: URL }, { id: index + 1, tool });
      insert.run(row.id, row.session_db_id, row.prompt_number, row.tool_name, row.tool_input, row.tool_response, row.created_at_epoch);
    }
    const records = readProductRecords((sql, params) => db.prepare(sql).all(...params), 100, 10, { database: db });
    expect(records.productCalls.map(row => row.id)).toEqual([2, 1]);
    expect(records.productCalls.flatMap(productsFromToolUse).map(product => product.url)).toEqual([URL, URL]);
  } finally { db.close(); }
});
