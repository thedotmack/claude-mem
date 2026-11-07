import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const modules = Object.fromEntries(['index', 'token-usage', 'setup-scan'].map(name =>
  [name, new URL(`../../../src/services/prompt-import/${name}.ts`, import.meta.url).href]));
const sessionStore = new URL('../../../src/services/sqlite/SessionStore.ts', import.meta.url).href;

function transcripts(codex: string, data: string, label: string, tokens: number) {
  const folder = join(codex, 'sessions', '2026', '11', '02');
  mkdirSync(folder, { recursive: true });
  const at = new Date(NOW - 1000).toISOString();
  writeFileSync(join(folder, 'rollout.jsonl'), [
    { timestamp: at, type: 'session_meta', payload: { timestamp: at, cli_version: '0.160.0', id: `codex-${label}`, source: 'cli', originator: 'codex_cli_rs', cwd: `/projects/${label}` } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', id: `user-${label}`,
      content: [{ type: 'input_text', text: `fix the ${label} Codex task` }] } },
    { timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { total_tokens: tokens }, last_token_usage: { total_tokens: tokens } } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const opencode = join(data, 'opencode');
  mkdirSync(opencode, { recursive: true });
  const db = new Database(join(opencode, 'opencode.db'));
  try {
    db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, data TEXT);`);
    db.query('INSERT INTO session VALUES(?, ?, NULL)').run(`opencode-${label}`, `/projects/${label}`);
    db.query('INSERT INTO message VALUES(?, ?, ?, ?)').run('user', `opencode-${label}`, NOW - 1000, JSON.stringify({ role: 'user' }));
    db.query('INSERT INTO part VALUES(?, ?, ?)').run('text', 'user', JSON.stringify({ type: 'text', text: `fix the ${label} OpenCode task` }));
    db.query('INSERT INTO message VALUES(?, ?, ?, ?)').run('assistant', `opencode-${label}`, NOW - 500,
      JSON.stringify({ role: 'assistant', tokens: { input: tokens, output: tokens } }));
  } finally { db.close(); }
}

for (const mode of ['unset', 'empty', 'absolute', 'relative', 'literal-spaces', 'literal-tilde', 'symlink', 'alternate-home', 'alternate-relative-home', 'same-home-relative', 'missing']) {
  it(`imports only the selected native Codex/OpenCode history: ${mode}`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-native-history-')));
    try {
      const home = join(root, 'owner');
      const alternate = join(root, 'alternate');
      const customCodex = join(root, mode === 'literal-spaces' ? ' codex profile ' : mode === 'literal-tilde' ? '~/codex' : 'custom-codex');
      const customData = join(root, mode === 'literal-spaces' ? ' data profile ' : mode === 'literal-tilde' ? '~/data' : 'custom-data');
      transcripts(join(home, '.codex'), join(home, '.local', 'share'), 'default', 11);
      transcripts(customCodex, customData, 'active', 111);
      transcripts(join(alternate, '.codex'), join(alternate, '.local', 'share'), 'alternate', 22);
      const codexLink = join(root, 'codex-link'), dataLink = join(root, 'data-link');
      if (mode === 'symlink') {
        symlinkSync(customCodex, codexLink, process.platform === 'win32' ? 'junction' : 'dir');
        symlinkSync(customData, dataLink, process.platform === 'win32' ? 'junction' : 'dir');
      }
      if (mode === 'missing') {
        rmSync(customCodex, { recursive: true });
        rmSync(customData, { recursive: true });
      }
      const script = join(root, 'scan.ts');
      writeFileSync(script, `
        import { mock } from 'bun:test';
        import * as originalOs from 'node:os';
        import { isAbsolute, relative, resolve, sep } from 'node:path';
        const root = process.env.OWNED_HISTORY_ROOT;
        for (const variable of ['CODEX_HOME', 'XDG_DATA_HOME']) {
          const value = process.env[variable];
          if (!value) continue;
          const rel = relative(root, resolve(value));
          if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Native override escaped owned fixture');
        }
        const home = process.env.OWNED_HISTORY_HOME;
        const inheritedHome = process.env.HOME;
        const ownedOs = { ...originalOs, homedir: () => home };
        mock.module('os', () => ({ ...ownedOs, default: ownedOs }));
        mock.module('node:os', () => ({ ...ownedOs, default: ownedOs }));
        if ((await import('os')).homedir() !== home) throw new Error('Owned home mock unavailable');
        const { scanOwnerPrompts } = await import(${JSON.stringify(modules.index)});
        const { scanTokenUsage } = await import(${JSON.stringify(modules['token-usage'])});
        const { SetupScan } = await import(${JSON.stringify(modules['setup-scan'])});
        const { SessionStore } = await import(${JSON.stringify(sessionStore)});
        const options = { agents: ['codex', 'opencode'], sinceEpochMs: ${NOW - 30 * 86400000},
          excludedProjects: '', resolveProject: () => 'example',
          ...(process.env.OWNED_SCAN_HOME ? { homeDirectory: process.env.OWNED_SCAN_HOME } : {}) };
        const prompts = await scanOwnerPrompts(options);
        const usage = await scanTokenUsage(options);
        const store = new SessionStore(':memory:', { syncOpsEnabled: false });
        try {
          const scanner = new SetupScan({ getStore: () => store, now: () => ${NOW}, scanOptions: options });
          scanner.start();
          const state = await scanner.finished();
          const rows = store.db.query('SELECT prompt_text FROM user_prompts ORDER BY prompt_text').all();
          console.log(JSON.stringify({ prompts: prompts.ownerPrompts.map(p => p.text).sort(),
            usage: usage.agents.map(a => ({ id: a.id, detected: a.detected, tokens: a.tokens })),
            added: state.added, rows, homePreserved: process.env.HOME === inheritedHome }));
        } finally { store.close(); }
      `);
      const env: NodeJS.ProcessEnv = { ...process.env, OWNED_HISTORY_ROOT: root, OWNED_HISTORY_HOME: home, CLAUDE_MEM_DATA_DIR: join(root, 'settings'),
        DO_NOT_TRACK: '1', CODEX_HOME: customCodex, XDG_DATA_HOME: customData };
      if (mode === 'unset') { delete env.CODEX_HOME; delete env.XDG_DATA_HOME; }
      if (mode === 'empty') { env.CODEX_HOME = ''; env.XDG_DATA_HOME = ''; }
      if (mode === 'relative') { env.CODEX_HOME = 'custom-codex'; env.XDG_DATA_HOME = 'custom-data'; }
      if (mode === 'literal-tilde') { env.CODEX_HOME = '~/codex'; env.XDG_DATA_HOME = '~/data'; }
      if (mode === 'symlink') { env.CODEX_HOME = codexLink; env.XDG_DATA_HOME = dataLink; }
      delete env.OWNED_SCAN_HOME;
      if (mode === 'alternate-home') env.OWNED_SCAN_HOME = alternate;
      if (mode === 'alternate-relative-home') env.OWNED_SCAN_HOME = 'alternate';
      if (mode === 'same-home-relative') env.OWNED_SCAN_HOME = 'owner';
      const child = Bun.spawnSync([process.execPath, script], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const line = child.stdout.toString().trim().split('\n').at(-1)!;
      const actual = JSON.parse(line);
      const label = mode.startsWith('alternate-') ? 'alternate' : ['unset', 'empty'].includes(mode) ? 'default' : 'active';
      const tokens = label === 'alternate' ? 22 : label === 'default' ? 11 : 111;
      const texts = [`fix the ${label} Codex task`, `fix the ${label} OpenCode task`];
      if (mode === 'missing') {
        expect(actual).toEqual({ prompts: [], added: 0, rows: [], usage: [
          { id: 'codex', detected: false, tokens: 0 }, { id: 'opencode', detected: false, tokens: 0 }], homePreserved: true });
        return;
      }
      expect(actual).toEqual({ prompts: texts, added: 2, rows: texts.map(prompt_text => ({ prompt_text })),
        usage: [{ id: 'codex', detected: true, tokens }, { id: 'opencode', detected: true, tokens: 2 * tokens }], homePreserved: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
