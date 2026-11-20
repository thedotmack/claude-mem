import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { readCandidates } from '../../../src/services/work-view/request-groups.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const SID = '11111111-aaaa-bbbb-cccc-000000000001';
const ASK = 'fix the failing startup sequence in the project';
const META_SID = '11111111-aaaa-bbbb-cccc-000000000002';
const AGENT_PROMPT = 'You are a coding assistant. ' + 'Follow the detailed task instructions from the previous agent. '.repeat(10);

for (const duplicate of [false, true]) {
  it(`does not persist a hook prompt as agent-written after a real transcript read failure (${duplicate ? 'another copy succeeds' : 'single source'})`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cmem-unreadable-session-'));
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const file = join(home, '.claude', 'projects', 'alpha', SID + '.jsonl');
      mkdirSync(join(file, '..'), { recursive: true });
      const record = (text: string, uuid: string) => ({ type: 'user', uuid, sessionId: SID, cwd: '/projects/alpha',
        origin: { kind: 'human' }, entrypoint: 'cli', timestamp: new Date(NOW - 1000).toISOString(),
        message: { role: 'user', content: text } });
      writeFileSync(file, JSON.stringify(record(ASK, 'newest')) + '\n');
      if (duplicate) {
        const copy = join(home, '.claude', 'projects', 'older-copy', SID + '.jsonl');
        mkdirSync(join(copy, '..'), { recursive: true });
        writeFileSync(copy, JSON.stringify(record('continue', 'earlier')) + '\n');
      }
      const session = store.createSDKSession(SID, 'alpha', ASK, undefined, 'claude');
      store.saveUserPrompt(SID, 1, ASK, session, undefined, undefined, NOW - 1000);
      const agentId = store.saveUserPrompt(SID, 2, AGENT_PROMPT, session, undefined, undefined, NOW - 500);
      const metaAsk = 'fix the unrelated generated task';
      const metaFile = join(home, '.claude', 'projects', 'alpha', META_SID + '.jsonl');
      writeFileSync(metaFile, JSON.stringify({ ...record(metaAsk, 'meta'), sessionId: META_SID, isMeta: true }) + '\n');
      const metaSession = store.createSDKSession(META_SID, 'alpha', metaAsk, undefined, 'claude');
      const metaId = store.saveUserPrompt(META_SID, 1, metaAsk, metaSession, undefined, undefined, NOW - 1000);
      const ledger = join(home, 'agent-written-prompts.json');
      let replaced = false;
      let scanned: Awaited<ReturnType<typeof scanOwnerPrompts>> | undefined;
      const scan = new SetupScan({
        getStore: () => store, now: () => NOW,
        scanOptions: { homeDirectory: home, agents: ['claude-code'], excludedProjects: '', resolveProject: () => 'alpha' },
        scan: async options => {
          scanned = await scanOwnerPrompts({ ...options, onProgress(progress) {
            options.onProgress?.(progress);
            if (!replaced && progress.phase === 'reading' && progress.bytesDone === 0) {
              // A real post-discovery open failure: no mock reader or synthetic exception.
              replaced = true;
              rmSync(file);
              mkdirSync(file);
            }
          } });
          return scanned;
        },
        readTokenUsage: async () => ({ windowStart: new Date(NOW - 30 * 86400000).toISOString(), windowDays: 30, agents: [] }),
        saveAgentWrittenPromptIds: promptIds => writeFileSync(ledger, JSON.stringify({ promptIds })),
      });
      scan.start();
      const result = await scan.finished();
      const excluded = JSON.parse(readFileSync(ledger, 'utf8')).promptIds;
      const candidates = readCandidates(store.db, { excludedPromptIds: new Set(excluded) });
      expect(replaced).toBe(true);
      expect(result.skippedSources).toBe(1);
      expect({ fromMemory: result.agents.find(agent => agent.id === 'claude-code')!.fromMemory,
        excluded: [...excluded].sort((a, b) => a - b), asks: candidates.map((candidate: { firstAsk: string }) => candidate.firstAsk) })
        .toEqual({ fromMemory: 1, excluded: [agentId, metaId].sort((a, b) => a - b), asks: [ASK] });
      expect(result.recentPrompts.some(prompt => prompt.text === ASK)).toBe(true);
      expect(scanned!.skippedSources[0].reason).toMatch(/EISDIR|EACCES|EPERM|directory/i);
      const claude = scanned!.agents.find(agent => agent.id === 'claude-code')!;
      expect(claude.sessions.has(SID)).toBe(true);
      expect(claude.incompleteSessions?.has(SID)).toBe(true);
      expect(claude.incompleteSessions?.has(META_SID)).toBe(false);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}
