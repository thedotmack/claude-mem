import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate frozen transcript/data paths and exercise the SQLite-to-render path.
const fixture = String.raw`
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { cwdToDashed } from './src/services/context/ObservationCompiler.ts';
  ModeManager.getInstance().loadMode('code');
  const cwd = '/owned/mixed-platform-checkout';
  const transcripts = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed(cwd));
  mkdirSync(transcripts, { recursive: true });
  const transcript = (id, text) => writeFileSync(join(transcripts, id + '.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
  const seed = (host, platform, epoch) => {
    const id = store.createSDKSession(host, 'mixed-project', 'prompt', undefined, platform);
    store.updateMemorySessionId(id, 'observer-' + host);
    store.storeObservation('observer-' + host, 'mixed-project', {
      type: 'discovery', title: host + ' observation', subtitle: null, narrative: 'n',
      facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [],
    }, 1, 0, epoch);
  };
  if (process.env.PRIOR_INCLUDE_CLAUDE === 'true') {
    seed('prior-claude', 'claude', 1700000000000);
    transcript('prior-claude', 'EXPECTED_CLAUDE_REPLY');
  }
  seed('newer-codex', 'codex', 1700000060000);
  if (process.env.PRIOR_COLLISION === 'true') transcript('newer-codex', 'UNRELATED_CLAUDE_REPLY');
  seed('active-claude', 'claude', 1700000120000);
  transcript('active-claude', 'CURRENT_SESSION_REPLY');
  store.close();
  const context = await generateContextWithStats({
    projects: ['mixed-project'], cwd, session_id: 'active-claude', includeHealthWarning: false,
  });
  console.log(JSON.stringify(context));
`;

function run(includeClaude: boolean, collision: boolean): { text: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prior-platform-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({
      CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true',
      CLAUDE_MEM_CONTEXT_FULL_COUNT: '0', CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'false',
    }));
    const child = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'),
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true', PRIOR_INCLUDE_CLAUDE: String(includeClaude), PRIOR_COLLISION: String(collision) },
      stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('prior transcript candidates respect their host platform', () => {
  for (const collision of [false, true]) {
    it(`finds the prior Claude reply past a newer Codex row (colliding file: ${collision})`, () => {
      const { text } = run(true, collision);
      expect(text).toContain('EXPECTED_CLAUDE_REPLY');
      expect(text).not.toContain('UNRELATED_CLAUDE_REPLY');
      expect(text).not.toContain('CURRENT_SESSION_REPLY');
      // The mixed-platform memory timeline itself keeps every observation.
      expect(text).toContain('newer-codex observation');
      expect(text).toContain('prior-claude observation');
    });
  }

  it('does not interpret a Codex session ID as a Claude transcript when no prior Claude row exists', () => {
    const { text } = run(false, true);
    expect(text).not.toContain('UNRELATED_CLAUDE_REPLY');
    expect(text).not.toContain('CURRENT_SESSION_REPLY');
    expect(text).toContain('newer-codex observation');
  });
});
