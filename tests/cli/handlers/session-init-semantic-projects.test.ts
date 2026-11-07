// Gate P2-5: semantic injection searched only the session's current project
// key, so a checkout re-keyed by a git-remote slug (or an environment, or a
// marker) never surfaced the memory it wrote under its older keys. The hook now
// sends every key the checkout reads.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

let tempRoot: string;
let slugRepo: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-mem-semantic-projects-')));
  slugRepo = path.join(tempRoot, 'api');
  mkdirSync(slugRepo, { recursive: true });
  execFileSync('git', ['init', '-q', slugRepo], { stdio: 'ignore' });
  execFileSync('git', ['-C', slugRepo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'], { stdio: 'ignore' });
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('sessionInitHandler semantic injection reads every key of the checkout (gate P2-5)', () => {
  it('sends the checkout\'s keys with the semantic query', () => {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_MEM_PROJECT_NAME_SOURCE: 'git-remote' };
    delete env.CLAUDE_MEM_INTERNAL;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
    const script = `
      const semanticBodies = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          CLAUDE_MEM_SEMANTIC_INJECT_FORMAT: 'index',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        getSessionInitRequestTimeoutMs: () => 12000,
        executeWithWorkerFallback: async (apiPath, method, body) => {
          if (apiPath === '/api/context/semantic') {
            semanticBodies.push(body);
            return { context: '', count: 0 };
          }
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
      });
      await sessionInitHandler.execute({
        sessionId: 'semantic-projects',
        cwd: ${JSON.stringify(slugRepo)},
        platform: 'claude-code',
        prompt: 'How did we wire the retry budget for the importer last week?',
      });
      const summary = semanticBodies.map(body => [body.project, body.projects, body.format]);
      const expected = [['acme/api', ['api', 'acme/api'], 'index']];
      if (JSON.stringify(summary) !== JSON.stringify(expected)) {
        throw new Error('semantic bodies mismatch: ' + JSON.stringify(summary));
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
