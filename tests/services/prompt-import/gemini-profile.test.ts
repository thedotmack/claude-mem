import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const modules = Object.fromEntries(['index', 'token-usage', 'setup-scan'].map(name =>
  [name, new URL(`../../../src/services/prompt-import/${name}.ts`, import.meta.url).href]));
const storeModule = new URL('../../../src/services/sqlite/SessionStore.ts', import.meta.url).href;

function profile(home: string, label: string, tokens: number): void {
  const config = join(home, '.gemini');
  const chats = join(config, 'tmp', label, 'chats'); mkdirSync(chats, { recursive: true });
  writeFileSync(join(config, 'projects.json'), JSON.stringify({ projects: { [`/owned/${label}`]: label } }));
  writeFileSync(join(chats, 'session-owned.json'), JSON.stringify({ sessionId: label, kind: 'main', messages: [
    { id: `user-${label}`, type: 'user', timestamp: new Date(NOW - 1000).toISOString(), content: [{ text: `Repair ${label} profile import` }] },
    { id: `answer-${label}`, type: 'gemini', timestamp: new Date(NOW - 500).toISOString(), content: 'Owned answer', tokens: { total: tokens } },
  ] }));
}

for (const mode of ['unset', 'empty', 'absolute', 'relative', 'literal-spaces', 'literal-tilde', 'alternate-home', 'missing']) {
  it(`imports Gemini prompts, checkout attribution and usage from the selected profile: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-gemini-profile-')));
    try {
      const home = join(root, 'owner'); const alternate = join(root, 'alternate');
      const active = join(root, mode === 'literal-spaces' ? ' profile ' : mode === 'literal-tilde' ? '~/profile' : 'active');
      profile(home, 'default', 11); profile(active, 'active', 111); profile(alternate, 'alternate', 22);
      if (mode === 'missing') rmSync(active, { recursive: true });
      const script = join(root, 'scan.ts');
      writeFileSync(script, `
        import { mock } from 'bun:test';
        import * as originalOs from 'node:os';
        const ownedOs = { ...originalOs, homedir: () => process.env.OWNED_GEMINI_HOME };
        mock.module('os', () => ({ ...ownedOs, default: ownedOs }));
        mock.module('node:os', () => ({ ...ownedOs, default: ownedOs }));
        const { scanOwnerPrompts } = await import(${JSON.stringify(modules.index)});
        const { scanTokenUsage } = await import(${JSON.stringify(modules['token-usage'])});
        const { SetupScan } = await import(${JSON.stringify(modules['setup-scan'])});
        const { SessionStore } = await import(${JSON.stringify(storeModule)});
        const options = { agents: ['gemini-cli'], sinceEpochMs: ${NOW - 86400000}, excludedProjects: '',
          resolveProject: cwd => cwd, ...(process.env.OWNED_SCAN_HOME ? { homeDirectory: process.env.OWNED_SCAN_HOME } : {}) };
        const prompts = await scanOwnerPrompts(options); const usage = await scanTokenUsage(options);
        const store = new SessionStore(':memory:', { syncOpsEnabled: false });
        try {
          const scanner = new SetupScan({ getStore: () => store, now: () => ${NOW}, scanOptions: options });
          scanner.start(); const result = await scanner.finished();
          console.log(JSON.stringify({ prompts: prompts.ownerPrompts.map(p => ({ text: p.text, cwd: p.cwd })),
            tokens: usage.agents[0].tokens, added: result.added,
            rows: store.db.query('SELECT p.prompt_text, s.project FROM user_prompts p JOIN sdk_sessions s ON s.id = p.session_db_id ORDER BY p.id').all() }));
        } finally { store.close(); }
      `);
      const env = { ...process.env, OWNED_GEMINI_HOME: home, GEMINI_CLI_HOME: active, CLAUDE_MEM_DATA_DIR: join(root, 'data'), DO_NOT_TRACK: '1' } as NodeJS.ProcessEnv;
      delete env.OWNED_SCAN_HOME;
      if (mode === 'unset') delete env.GEMINI_CLI_HOME;
      if (mode === 'empty') env.GEMINI_CLI_HOME = '';
      if (mode === 'relative') env.GEMINI_CLI_HOME = 'active';
      if (mode === 'literal-tilde') env.GEMINI_CLI_HOME = '~/profile';
      if (mode === 'alternate-home') env.OWNED_SCAN_HOME = alternate;
      const child = Bun.spawnSync([process.execPath, script], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const result = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
      const label = mode === 'alternate-home' ? 'alternate' : ['unset', 'empty'].includes(mode) ? 'default' : 'active';
      expect(result).toEqual(mode === 'missing' ? { prompts: [], tokens: 0, added: 0, rows: [] } : {
        prompts: [{ text: `Repair ${label} profile import`, cwd: `/owned/${label}` }],
        tokens: label === 'active' ? 111 : label === 'alternate' ? 22 : 11, added: 1,
        rows: [{ prompt_text: `Repair ${label} profile import`, project: `/owned/${label}` }],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
