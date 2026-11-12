import { expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

it('bootstraps a large indexed project and durably retains its missing prompt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chroma-large-bootstrap-'));
  const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = directory;
  ChromaSyncState.resetCacheForTests();
  const store = new SessionStore(join(directory, 'memory.db'));
  // Exceeds the JS call-argument ceiling while exercising ordinary 1000-doc
  // Chroma pages and the real SQLite prompt selection, not a private helper.
  const total = 1_000_001;
  const missing = 17;
  const project = 'large-indexed-project';
  let pageReads = 0;
  const transport = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({
    acceptsMutations: () => true,
    callTool: async (tool: string, args: any) => {
      if (tool === 'chroma_create_collection') return {};
      if (tool !== 'chroma_get_documents') throw new Error(`Unexpected Chroma operation: ${tool}`);
      pageReads++;
      const ids: string[] = [];
      const metadatas: Array<{ sqlite_id: number; doc_type: string }> = [];
      for (let position = args.offset; position < Math.min(args.offset + args.limit, total - 1); position++) {
        const id = position + 1 >= missing ? position + 2 : position + 1;
        ids.push(`prompt_${id}`);
        metadatas.push({ sqlite_id: id, doc_type: 'user_prompt' });
      }
      return { ids, metadatas };
    },
  } as any);
  try {
    const session = store.createSDKSession('large-session', project, 'Opening');
    store.db.query(`
      WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
      INSERT INTO user_prompts(session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      SELECT ?, 'large-session', n, 'Indexed prompt', '2026-11-01T00:00:00.000Z', 1793491200000 + n FROM numbers
    `).run(total, session);

    await new ChromaSync('large-bootstrap').bootstrapWatermarksFromChroma(project, store);

    ChromaSyncState.resetCacheForTests();
    expect(pageReads).toBe(1001);
    expect(ChromaSyncState.get(project)).toMatchObject({ observations: 0, summaries: 0, prompts: total });
    expect(ChromaSyncState.getPending(project, 'prompts')).toEqual([missing]);
  } finally {
    transport.mockRestore();
    store.close();
    ChromaSyncState.resetCacheForTests();
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
