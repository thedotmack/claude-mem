import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { mock } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';
import { parseProjectList } from '../../../src/shared/project-list.js';

const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const project = 'checkout';
const root = join(dataDir, project);
const rootRelative = 'packages/api/src/handler.ts';
const absolutePath = join(root, rootRelative);
mkdirSync(dirname(absolutePath), { recursive: true });
writeFileSync(absolutePath, '// file-history fixture\n'.repeat(100));
utimesSync(absolutePath, new Date('2020-01-01'), new Date('2020-01-01'));
execFileSync('git', ['init', '--quiet', root]);
const nestedCwd = join(root, 'packages/api');
const linkedCwd = join(dataDir, 'linked-api');
if (process.argv[2] === 'linked') symlinkSync(nestedCwd, linkedCwd, 'junction');
const cwd = process.argv[2] === 'linked' ? linkedCwd : process.argv[2] === 'nested' ? nestedCwd : root;
const inputAbsolutePath = process.argv[2] === 'linked' && process.argv[3] !== 'physical'
  ? join(linkedCwd, 'src/handler.ts') : absolutePath;
const cwdRelative = relative(cwd, inputAbsolutePath);
const store = new SessionStore(':memory:');

function seed(title: string, evidencePath: string, sourceProject = project, platform = 'claude', mergedInto: string | null = null): void {
  const sessionId = `session-${title}`;
  const sdkId = store.createSDKSession(sessionId, sourceProject, 'prompt', undefined, platform);
  store.ensureMemorySessionIdRegistered(sdkId, sessionId);
  const id = store.storeObservation(sessionId, sourceProject, {
    type: 'discovery', title, subtitle: null, facts: [], narrative: title,
    concepts: [], files_read: [evidencePath], files_modified: [],
  }, 1).id;
  store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run(mergedInto, id);
}

seed('ROOT_RELATIVE_HISTORY', rootRelative);
seed('ABSOLUTE_HISTORY', inputAbsolutePath);
seed('CWD_RELATIVE_HISTORY', cwdRelative);
seed('ADOPTED_HISTORY', rootRelative, 'checkout/merged-worktree', 'claude', project);
seed('FOREIGN_PROJECT_HISTORY', rootRelative, 'unrelated');
seed('OTHER_PLATFORM_HISTORY', rootRelative, project, 'codex');
seed('OTHER_FILE_HISTORY', 'packages/api/src/unrelated.ts');
seed('SIBLING_PATH_HISTORY', '../linked-api/src/handler.ts');

const workerUtilsPath = resolve(import.meta.dir, '../../../src/shared/worker-utils.ts');
const realWorkerUtils = { ...await import(workerUtilsPath) };
mock.module(workerUtilsPath, () => ({
  ...realWorkerUtils,
  executeWithWorkerFallback: async (apiPath: string) => {
    const query = new URL(apiPath, 'http://worker');
    assert.equal(query.pathname, '/api/observations/by-file');
    const observations = getObservationsByFilePath(store.db, query.searchParams.getAll('path'), {
      projects: parseProjectList(query.searchParams.getAll('projects')),
      platformSource: query.searchParams.get('platformSource') ?? undefined,
      limit: Number(query.searchParams.get('limit')),
    });
    return { observations, count: observations.length };
  },
}));

try {
  const { fileContextHandler } = await import('../../../src/cli/handlers/file-context.js');
  const result = await fileContextHandler.execute({
    sessionId: 'read-session', cwd, platform: 'claude-code', toolName: 'Read',
    toolInput: { file_path: process.argv[3] === 'relative' ? cwdRelative : inputAbsolutePath },
  });
  const context = result.hookSpecificOutput?.additionalContext ?? '';
  for (const title of ['ROOT_RELATIVE_HISTORY', 'ABSOLUTE_HISTORY', 'CWD_RELATIVE_HISTORY', 'ADOPTED_HISTORY']) {
    assert.ok(context.includes(title), `Missing ${title} from ${process.argv[2]} cwd (${process.argv[3]} input): ${context}`);
  }
  for (const title of ['FOREIGN_PROJECT_HISTORY', 'OTHER_PLATFORM_HISTORY', 'OTHER_FILE_HISTORY', 'SIBLING_PATH_HISTORY']) {
    assert.ok(!context.includes(title), `File history crossed its scope: ${title}`);
  }
} finally {
  store.close();
}
