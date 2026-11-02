import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { codexAdapter } from '../../src/cli/adapters/codex.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { ingestObservation, requireIngestContext, setIngestContext, type IngestContext } from '../../src/services/worker/http/shared.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

// Current Codex PostToolUse contract: https://learn.chatgpt.com/docs/hooks#posttooluse
// Producer: openai/codex codex-rs/core/src/tools/handlers/apply_patch.rs post_tool_use_payload.
const hookFixture = JSON.parse(readFileSync(new URL('../fixtures/codex/post-tool-use-apply-patch.json', import.meta.url), 'utf8'));

describe('Codex hook patch file evidence', () => {
  for (const kind of ['fixture-input', 'update', 'add', 'move', 'legacy-patch', 'bash-control']) {
    it(`keeps completed patch files searchable: ${kind}`, async () => {
      const cleanup: Array<() => void> = [];
      try {
        const cwd = mkdtempSync(join(tmpdir(), 'owned-codex-patch-'));
        cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
        mkdirSync(join(cwd, 'src'));
        const oldPath = 'src/owned.ts';
        const newPath = kind === 'move' ? 'src/moved.ts' : oldPath;
        if (kind !== 'add') writeFileSync(join(cwd, oldPath), 'old\n');
        if (kind === 'move') renameSync(join(cwd, oldPath), join(cwd, newPath));
        writeFileSync(join(cwd, newPath), 'new\n');
        expect(readFileSync(join(cwd, newPath), 'utf8')).toBe('new\n');
        const patch = kind === 'add'
          ? `*** Begin Patch\n*** Add File: ${newPath}\n+new\n*** End Patch`
          : `*** Begin Patch\n*** Update File: ${oldPath}\n${kind === 'move' ? `*** Move to: ${newPath}\n` : ''}@@\n-old\n+new\n*** End Patch`;
        const expected = kind === 'bash-control' ? [] : kind === 'move' ? [oldPath, newPath] : [newPath];
        const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
          ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'owned-fixture-key',
          CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
          CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
        }));
        cleanup.push(() => settings.mockRestore());
        const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
        const priorMode = mode.activeMode, priorId = mode.activeModeId;
        cleanup.push(() => { mode.activeMode = priorMode; mode.activeModeId = priorId; });
        mode.loadMode('code');
        const store = new SessionStore(':memory:');
        cleanup.push(() => store.close());
        const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
          getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
        const manager = new SessionManager(db);
        let priorContext: IngestContext | null = null;
        try { priorContext = requireIngestContext(); } catch { /* no prior fixture */ }
        cleanup.push(() => setIngestContext(priorContext as IngestContext));
        setIngestContext({ dbManager: db, sessionManager: manager,
          eventBroadcaster: { broadcastObservationQueued() {} } as any,
          ensureGeneratorRunning: async () => {},
        });
        const input = codexAdapter.normalizeInput({ ...hookFixture, session_id: `owned-patch-${kind}`,
          cwd, tool_name: kind === 'bash-control' ? 'Bash' : 'apply_patch',
          tool_input: kind === 'fixture-input' ? hookFixture.tool_input : kind === 'legacy-patch' ? { patch } : { command: patch },
          tool_use_id: `owned-call-${kind}`,
        });
        const outcome = await ingestObservation({ contentSessionId: input.sessionId!, platformSource: 'codex',
          cwd: input.cwd, toolName: input.toolName!, toolInput: input.toolInput, toolResponse: input.toolResponse,
          toolUseId: input.toolUseId,
        });
        expect(outcome.ok).toBe(true);
        const sid = (store.db.query('SELECT id FROM sdk_sessions').get() as { id: number }).id;
        const session = manager.initializeSession(sid);
        cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
        const realFetch = globalThis.fetch;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
          await req.json();
          return Response.json({ candidates: [{ content: { parts: [{ text:
            `<observation><type>bugfix</type><title>Owned patch applied</title><files_modified><file>${newPath}</file></files_modified></observation>` }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
        } });
        cleanup.push(() => server.stop(true));
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_input, init) => realFetch(`http://127.0.0.1:${server.port}/generate`, init));
        cleanup.push(() => fetchSpy.mockRestore());
        const broadcasts: unknown[] = [];
        await new GeminiProvider(db, manager).startSession(session, {
          sseBroadcaster: { broadcast(event: unknown) { broadcasts.push(event); } } as any,
          broadcastProcessingStatus() { if (manager.getTotalQueueDepth() === 0) session.abortController.abort(); },
        });
        const rows = store.db.query('SELECT id, files_modified FROM observations').all() as Array<{ id: number; files_modified: string }>;
        const lookup = new SessionSearch(store.db).findByFile(newPath).observations;
        console.log(JSON.stringify({ kind, expected, rows, lookupIds: lookup.map(row => row.id) }));
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].files_modified)).toEqual(expected);
        expect(lookup.map(row => row.id)).toEqual(kind === 'bash-control' ? [] : [rows[0].id]);
        expect(JSON.parse((broadcasts.find((event: any) => event.type === 'new_observation') as any).observation.files_modified)).toEqual(expected);
        expect(manager.getTotalQueueDepth()).toBe(0);
      } finally {
        for (const release of cleanup.reverse()) release();
      }
    }, 10000);
  }
});
