import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The worker route and the server-runtime hook name the projects they render.
// Resolving the cwd's project context on top of that ran `git rev-parse` (plus
// the remote lookup in git-remote naming mode) on every render, for a result
// nothing read. With the host's real cwd that is a real git process per render.
const fixture = String.raw`
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
  const session = store.createSDKSession('named-host', 'named-project', 'prompt');
  store.updateMemorySessionId(session, 'named-observer');
  store.storeObservation('named-observer', 'named-project', { type: 'discovery', title: 'NAMED_PROJECT_ROW', subtitle: null, narrative: 'n', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
  store.close();
  // Only the render runs with the recording git first on PATH.
  process.env.PATH = process.env.RECORDING_GIT_DIR + ':' + process.env.PATH;
  const input = { projects: ['named-project'], cwd: process.env.CHECKOUT };
  const model = await generateContextWithStats(input);
  const colored = await generateContextWithStats(input, true);
  console.log(JSON.stringify({ model: model.text, colored: colored.text }));
`;

describe('context rendered for named projects', () => {
  (process.platform === 'win32' ? it.skip : it)('never resolves the cwd project through git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-named-projects-'));
    try {
      const bin = join(dir, 'bin');
      const calls = join(dir, 'git-calls.log');
      for (const sub of ['bin', 'data', 'checkout']) mkdirSync(join(dir, sub));
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 128\n`);
      chmodSync(join(bin, 'git'), 0o755);
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, RECORDING_GIT_DIR: bin, CHECKOUT: join(dir, 'checkout'), CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.model).toContain('NAMED_PROJECT_ROW');
      expect(result.colored).toContain('NAMED_PROJECT_ROW');
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
