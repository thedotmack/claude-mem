import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

function scriptLiteral(value: string): string {
  return JSON.stringify(value.replace(/\\/g, '/'));
}

describe('generateContext session isolation', () => {
  let tempRoot: string;
  let tempDataDir: string;
  let tempConfigDir: string;
  let cwd: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-context-isolation-'));
    tempDataDir = join(tempRoot, 'claude-mem');
    tempConfigDir = join(tempRoot, 'claude-config');
    cwd = '/Users/tester/shared-project';

    mkdirSync(tempDataDir, { recursive: true });
    mkdirSync(tempConfigDir, { recursive: true });

    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true',
        CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
        CLAUDE_MEM_CONTEXT_FULL_COUNT: '10',
      }),
      'utf-8'
    );
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('excludes same-project observations, summaries, and prior transcript text from other sessions', () => {
    const script = `
      import { mkdirSync, writeFileSync } from 'fs';
      import { join } from 'path';
      import { SessionStore } from ${scriptLiteral('file:///D:/Repos/claude-mem-pr-2909-session-context-isolation/src/services/sqlite/SessionStore.ts')};
      import { ModeManager } from ${scriptLiteral('file:///D:/Repos/claude-mem-pr-2909-session-context-isolation/src/services/domain/ModeManager.ts')};
      import { generateContext } from ${scriptLiteral('file:///D:/Repos/claude-mem-pr-2909-session-context-isolation/src/services/context/ContextBuilder.ts')};

      const project = 'shared-project';
      const sessionA = 'session-a';
      const sessionB = 'session-b';
      const cwd = ${scriptLiteral(cwd)};

      const iso = epoch => new Date(epoch).toISOString();
      const store = new SessionStore();

      const seedSession = (contentSessionId, memorySessionId, startedAtEpoch) => {
        store.importSdkSession({
          content_session_id: contentSessionId,
          memory_session_id: memorySessionId,
          project,
          user_prompt: \`Prompt for \${memorySessionId}\`,
          started_at: iso(startedAtEpoch),
          started_at_epoch: startedAtEpoch,
          completed_at: iso(startedAtEpoch + 1),
          completed_at_epoch: startedAtEpoch + 1,
          status: 'completed',
        });
      };

      seedSession('content-a', sessionA, 1700001000000);
      seedSession('content-b', sessionB, 1700001010000);

      store.importObservation({
        memory_session_id: sessionA,
        project,
        text: null,
        type: 'discovery',
        title: 'Session A observation',
        subtitle: null,
        facts: '["Session A fact"]',
        narrative: 'Session A narrative',
        concepts: '["gotcha"]',
        files_read: null,
        files_modified: null,
        prompt_number: 1,
        discovery_tokens: 10,
        created_at: iso(1700001020000),
        created_at_epoch: 1700001020000,
      });
      store.importObservation({
        memory_session_id: sessionB,
        project,
        text: null,
        type: 'discovery',
        title: 'Session B observation',
        subtitle: null,
        facts: '["Session B fact"]',
        narrative: 'Session B narrative',
        concepts: '["gotcha"]',
        files_read: null,
        files_modified: null,
        prompt_number: 1,
        discovery_tokens: 10,
        created_at: iso(1700001030000),
        created_at_epoch: 1700001030000,
      });

      store.importSessionSummary({
        memory_session_id: sessionA,
        project,
        request: 'Session A request',
        investigated: 'Session A investigated',
        learned: 'Session A learned',
        completed: 'Session A completed',
        next_steps: 'Session A next',
        files_read: null,
        files_edited: null,
        notes: null,
        prompt_number: 1,
        discovery_tokens: 0,
        created_at: iso(1700001040000),
        created_at_epoch: 1700001040000,
      });
      store.importSessionSummary({
        memory_session_id: sessionB,
        project,
        request: 'Session B request',
        investigated: 'Session B investigated',
        learned: 'Session B learned',
        completed: 'Session B completed',
        next_steps: 'Session B next',
        files_read: null,
        files_edited: null,
        notes: null,
        prompt_number: 1,
        discovery_tokens: 0,
        created_at: iso(1700001050000),
        created_at_epoch: 1700001050000,
      });

      store.close();

      const dashedCwd = cwd.replace(/[/.]/g, '-');
      const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', dashedCwd);
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        join(transcriptDir, \`\${sessionB}.jsonl\`),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Session B prior transcript message' }] },
        }) + '\\n',
        'utf-8'
      );

      ModeManager.getInstance().loadMode('code');
      const context = await generateContext({ cwd, session_id: sessionA });
      process.stdout.write(context);
    `;

    const context = execFileSync(
      'bun',
      ['-e', script],
      {
        cwd: 'D:/Repos/claude-mem-pr-2909-session-context-isolation',
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: tempDataDir,
          CLAUDE_CONFIG_DIR: tempConfigDir,
        },
      }
    );

    expect(context).toContain('Session A observation');
    expect(context).toContain('Session A request');
    expect(context).toContain('Session A completed');
    expect(context).not.toContain('Session B observation');
    expect(context).not.toContain('Session B request');
    expect(context).not.toContain('Session B completed');
    expect(context).not.toContain('Session B prior transcript message');
    expect(context).not.toContain('**Previously**');
  });
});
