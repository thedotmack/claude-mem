import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { kimiAdapter } from '../../src/cli/adapters/kimi.js';
import { summarizeHandler } from '../../src/cli/handlers/summarize.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import * as hookSettings from '../../src/shared/hook-settings.js';
import { extractLastAssistantTurn, extractLastMessageFromJsonl } from '../../src/shared/transcript-parser.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../helpers/temp-hook-spool.js';

// Kimi's legacy-session importer writes every message, including assistant
// replies, as context.append_message in buildTurnRecords (turn-structure.ts).
const answer = 'Restored the migration.\nVerified the imported session.';
const migratedWire = [
  { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'Finish the migration.' }], origin: { kind: 'user' }, time: 1 },
  { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'Finish the migration.' }] } },
  { type: 'context.append_message', message: { role: 'assistant', content: [
    { type: 'think', think: 'Internal reasoning is not the answer.' },
    { type: 'text', text: 'Restored the migration.' },
    { type: 'text', text: 'Verified the imported session.' },
  ] } },
  { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed', time: 1 },
].map(record => JSON.stringify(record)).join('\n') + '\n';

describe('Kimi appended assistant messages', () => {
  let temp: ReturnType<typeof useTempHookSpoolDataDir>;
  let settingsSpy: ReturnType<typeof spyOn>;
  let wirePath: string;
  const originalHome = process.env.KIMI_CODE_HOME;
  const originalDisableSummary = process.env.CLAUDE_MEM_DISABLE_SUMMARY;

  beforeEach(() => {
    temp = useTempHookSpoolDataDir();
    process.env.KIMI_CODE_HOME = join(temp.dataDir, 'kimi');
    delete process.env.CLAUDE_MEM_DISABLE_SUMMARY;
    const sessionDir = join(process.env.KIMI_CODE_HOME, 'sessions', 'workdir-key', 'imported-session', 'agents', 'main');
    mkdirSync(sessionDir, { recursive: true });
    wirePath = join(sessionDir, 'wire.jsonl');
    writeFileSync(wirePath, migratedWire);
    settingsSpy = spyOn(hookSettings, 'loadFromFileOnce').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_OBSERVER_ENABLED: 'true',
      CLAUDE_MEM_CAPTURE_ADVISOR_CALLS: 'false',
      CLAUDE_MEM_DELIVERABLES_ENABLED: 'false',
      CLAUDE_MEM_RUNTIME: 'worker',
    });
  });

  afterEach(() => {
    settingsSpy.mockRestore();
    if (originalHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = originalHome;
    if (originalDisableSummary === undefined) delete process.env.CLAUDE_MEM_DISABLE_SUMMARY;
    else process.env.CLAUDE_MEM_DISABLE_SUMMARY = originalDisableSummary;
    temp.restore();
  });

  test('reads assistant text from the native importer envelope', () => {
    expect(extractLastMessageFromJsonl(migratedWire, 'assistant', false)).toBe(answer);
    expect(extractLastMessageFromJsonl(migratedWire, 'user', false)).toBe('Finish the migration.');
  });

  test('uses a newer appended reply instead of older loop-event text across disk chunks', () => {
    const oldReply = JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Outdated answer.' } } });
    writeFileSync(wirePath, `${oldReply}\n${migratedWire}`);
    expect(extractLastAssistantTurn(wirePath, true, { initialBytes: 64, maxChunkBytes: 97 })).toEqual({ text: answer });
  });

  test('hands an imported reply to Stop through real Kimi transcript discovery', async () => {
    const input = kimiAdapter.normalizeInput({ session_id: 'imported-session', cwd: temp.dataDir, hook_event_name: 'Stop' });
    expect(input.transcriptPath).toBe(wirePath);
    const result = await summarizeHandler.execute({ ...input, platform: 'kimi' });
    expect(result.exitCode).toBe(0);
    const summaries = spooledEntries('summarize');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload.lastAssistantMessage).toBe(answer);
    expect(summaries[0].payload.platformSource).toBe('kimi');
  });
});
