import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
// Gemini's ChatRecordingService.newMessage preserves PartListUnion for both
// content and displayContent, including strings (google-gemini/gemini-cli
// 1930f25394c4b6338b64ffdb43083fca41614798, chatRecordingTypes.ts / chatRecordingService.ts).
for (const extension of ['json', 'jsonl']) {
  it(`imports the displayed Gemini prompt, not expanded model content (${extension})`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cmem-gemini-display-'));
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    try {
      const chats = join(home, '.gemini', 'tmp', 'owned-project', 'chats');
      mkdirSync(chats, { recursive: true });
      const typed = 'Review the handling of @src/parser.ts';
      const arrayText = 'Keep the existing array display representation';
      const ordinary = 'A plain prompt without separate display content';
      const message = (id: string, content: unknown, displayContent?: unknown) => ({
        id, type: 'user', timestamp: new Date(NOW - 10_000).toISOString(), content,
        ...(displayContent === undefined ? {} : { displayContent }),
      });
      const messages = [
        message('typed', [{ text: 'EXPANDED_FILE_BODY_AND_MODEL_ONLY_CONTEXT' }], typed),
        message('array', [{ text: 'EXPANDED_ARRAY_BODY' }], [{ text: arrayText }]),
        message('ordinary', ordinary),
        message('empty', 'SYNTHETIC_CONTINUATION_WITH_NO_DISPLAY_TEXT', ''),
        message('spaces', 'SYNTHETIC_CONTINUATION_WITH_BLANK_DISPLAY_TEXT', '  \n '),
        message('private', 'PRIVATE_MODEL_EXPANSION', '<private>private typed request</private>'),
      ];
      const header = { sessionId: 'owned-session', kind: 'main' };
      const original = extension === 'json'
        ? JSON.stringify({ ...header, messages })
        : [header, ...messages].map(record => JSON.stringify(record)).join('\n') + '\n';
      const transcript = join(chats, `session-owned.${extension}`);
      writeFileSync(transcript, original);
      const options = { homeDirectory: home, agents: ['gemini-cli' as const], sinceEpochMs: NOW - 86400_000,
        excludedProjects: '', resolveProject: () => 'owned-project' };
      const result = await scanOwnerPrompts(options);
      const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: options });
      scanner.start();
      const state = await scanner.finished();
      const rows = store.db.query('SELECT prompt_text, native_prompt_id FROM user_prompts ORDER BY id').all();
      expect({ text: result.ownerPrompts.map(prompt => prompt.text), added: state.added, rows }).toEqual({
        text: [typed, arrayText, ordinary], added: 3,
        rows: [
          { prompt_text: typed, native_prompt_id: 'transcript:typed' },
          { prompt_text: arrayText, native_prompt_id: 'transcript:array' },
          { prompt_text: ordinary, native_prompt_id: 'transcript:ordinary' },
        ],
      });
      expect(result.skippedSources).toEqual([]);
      expect(readFileSync(transcript, 'utf8')).toBe(original);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}
