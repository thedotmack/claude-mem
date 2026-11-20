import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const FIRST = 'Review the import history and preserve the original author of each recorded request.';
const SECOND = 'Check the actual stored rows and ensure that model-generated instructions are excluded from the owner goals without losing genuine requests.';
const AUTHORED = FIRST + '\n' + SECOND;
const OWNER = 'Please inspect the existing document without claiming authorship of its contents. This paragraph was supplied by the user, so reading it in a tool response must not make it model-written evidence.';

async function inspect(extension: 'json' | 'jsonl', content: unknown, generatedAt = NOW - 10_000) {
  const home = mkdtempSync(join(tmpdir(), 'gemini-native-provenance-'));
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const chats = join(home, '.gemini', 'tmp', 'fixture-project', 'chats');
    mkdirSync(chats, { recursive: true });
    const messages = [
      { id: 'answer', type: 'gemini', timestamp: new Date(generatedAt).toISOString(), content },
      { id: 'copied', type: 'user', timestamp: new Date(NOW - 1000).toISOString(), content: [{ text: AUTHORED }] },
      { id: 'owner', type: 'user', timestamp: new Date(NOW - 500).toISOString(), content: [{ text: OWNER }] },
    ];
    const header = { sessionId: 'native-gemini', kind: 'main' };
    const original = extension === 'json' ? JSON.stringify({ ...header, messages })
      : [header, ...messages].map(record => JSON.stringify(record)).join('\n') + '\n';
    const transcript = join(chats, 'session-native.' + extension);
    writeFileSync(transcript, original);
    const options = { homeDirectory: home, agents: ['gemini-cli' as const], sinceEpochMs: NOW - 86400_000,
      excludedProjects: '', resolveProject: () => 'fixture-project' };
    const result = await scanOwnerPrompts({
      ...options,
      memoryPrompts: [
        { id: 71, platformSource: 'gemini-cli', contentSessionId: 'hook-session',
          promptText: AUTHORED, createdAtEpoch: NOW - 1000 },
        { id: 72, platformSource: 'gemini-cli', contentSessionId: 'hook-session',
          promptText: OWNER, createdAtEpoch: NOW - 500 },
      ],
    });
    const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: options });
    scanner.start();
    const state = await scanner.finished();
    const rows = store.db.query('SELECT prompt_text FROM user_prompts ORDER BY id').all() as Array<{ prompt_text: string }>;
    expect(result.skippedSources).toEqual([]);
    expect(state.error).toBeNull();
    expect(readFileSync(transcript, 'utf8')).toBe(original);
    return {
      owners: result.ownerPrompts.map(prompt => prompt.text),
      generated: result.agentWritten.map(prompt => prompt.text),
      hookOwners: [...result.ownerMemoryPromptIds],
      added: state.added,
      stored: rows.map(row => row.prompt_text),
    };
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const generatedResult = { owners: [OWNER], generated: [AUTHORED], hookOwners: [72], added: 1, stored: [OWNER] };
const ownerResult = { owners: [AUTHORED, OWNER], generated: [], hookOwners: [71, 72], added: 2, stored: [AUTHORED, OWNER] };

// Gemini CLI e5d88fb2c036ce7e0c27131469cd963221b9d9e7:
// ChatRecordingService.updateMessagesFromHistory writes native content.parts,
// whose text parts have { text }, without a "type": "text" discriminator.
for (const extension of ['json', 'jsonl'] as const) {
  it('retains native Gemini text-part provenance through scan and SQLite import (' + extension + ')', async () => {
    expect(await inspect(extension, [
      { text: FIRST },
      { inlineData: { mimeType: 'text/plain', data: Buffer.from(OWNER).toString('base64') } },
      { functionResponse: { name: 'read_file', response: { output: OWNER } } },
      { text: SECOND },
    ])).toEqual(generatedResult);
  });

  it('keeps existing string Gemini provenance (' + extension + ')', async () => {
    expect(await inspect(extension, AUTHORED)).toEqual(generatedResult);
  });
}

it('does not attribute earlier requests to later native Gemini text', async () => {
  expect(await inspect('jsonl', [{ text: AUTHORED }], NOW)).toEqual(ownerResult);
});

it('does not treat native media and tool-result fields as authored Gemini text', async () => {
  expect(await inspect('jsonl', [
    { inlineData: { mimeType: 'text/plain', data: Buffer.from(AUTHORED).toString('base64') } },
    { functionResponse: { name: 'read_file', response: { output: AUTHORED } } },
    { fileData: { mimeType: 'text/plain', fileUri: 'file:///fixture/user.txt' } },
  ])).toEqual(ownerResult);
});
