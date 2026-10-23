import { afterEach, describe, expect, it } from 'bun:test';
import { serverVectorSearchAllowed } from '../../src/npx-cli/commands/runtime.js';

// `server start`/`restart`/`worker start` install the ~300 MB embedder only
// when the server may search by meaning.
describe('server embedder install gate', () => {
  const saved = process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH;
    else process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = saved;
  });

  it('skips the install when CLAUDE_MEM_SERVER_VECTOR_SEARCH is false', () => {
    process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'false';
    expect(serverVectorSearchAllowed()).toBe(false);
    process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'FALSE';
    expect(serverVectorSearchAllowed()).toBe(false);
  });

  it('installs it for auto (the default) and true', () => {
    delete process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH;
    expect(serverVectorSearchAllowed()).toBe(true);
    process.env.CLAUDE_MEM_SERVER_VECTOR_SEARCH = 'true';
    expect(serverVectorSearchAllowed()).toBe(true);
  });
});
