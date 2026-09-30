// Gate P1-2: UserPromptSubmit tells the worker which checkout the session's
// project key came from and how that key was derived, so the worker can record
// both even for a session that never reports an observation.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

let tempRoot: string;
let folderProject: string;
let slugRepo: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-mem-init-checkout-')));
  folderProject = path.join(tempRoot, 'plain-folder');
  slugRepo = path.join(tempRoot, 'api');
  mkdirSync(folderProject, { recursive: true });
  mkdirSync(slugRepo, { recursive: true });
  execFileSync('git', ['init', '-q', slugRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', slugRepo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'], { stdio: 'ignore' });
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('sessionInitHandler sends the checkout and its key source (gate P1-2)', () => {
  it('reports a folder-derived and a git-remote-derived key', () => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_MEM_PROJECT_NAME_SOURCE: 'git-remote' };
    delete env.CLAUDE_MEM_INTERNAL;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
    const script = `
      const initBodies = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'false',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        executeWithWorkerFallback: async (apiPath, method, body) => {
          if (apiPath === '/api/sessions/init') initBodies.push(body);
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
      });
      for (const [sessionId, cwd] of [['folder-session', ${JSON.stringify(folderProject)}], ['slug-session', ${JSON.stringify(slugRepo)}]]) {
        await sessionInitHandler.execute({ sessionId, cwd, platform: 'claude-code', prompt: 'hello' });
      }
      const summary = initBodies.map(body => [body.project, body.cwd, body.projectKeySource]);
      const expected = [
        ['plain-folder', ${JSON.stringify(folderProject)}, 'path'],
        ['acme/api', ${JSON.stringify(slugRepo)}, 'git-remote'],
      ];
      if (JSON.stringify(summary) !== JSON.stringify(expected)) {
        throw new Error('init bodies mismatch: ' + JSON.stringify(summary));
      }
    `;

    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
