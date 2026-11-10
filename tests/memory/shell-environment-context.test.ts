import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';

const repo = join(import.meta.dir, '..', '..');
const adapterPath = join(repo, 'src/cli/adapters/codex.ts');
const workerEntry = process.env.CMEM_SHELL_HOOK_BUNDLE || join(repo, 'src/services/worker-service.ts');
const project = 'shell-environment-fixture';
const title = 'Feedback timeout preference';
let root: string;
let notes: string;
let file: string;
let db: Database;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let environment: Record<string, string | undefined>;
let lookups: Array<Record<string, unknown>>;
let observationId: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cmem-shell-env-'));
  notes = join(root, 'owned notes');
  mkdirSync(notes);
  file = join(notes, 'feedback.md');
  writeFileSync(file, 'timeout preference\n');
  // A different, valid file makes accidental interpolation of literal operands visible.
  mkdirSync(join(root, '$CMEM_NOTES_DIR'));
  writeFileSync(join(root, '$CMEM_NOTES_DIR', 'feedback.md'), 'literal dollar path\n');
  db = new Database(':memory:');
  const store = new SessionStore(db);
  const session = store.getOrCreateManualSession(project, 'codex');
  observationId = store.storeObservation(session, project, {
    type: 'decision', title, subtitle: null, narrative: 'PRIVATE_FULL_RECORD',
    facts: [], concepts: [], files_read: [file], files_modified: [],
  }, 1).id;
  const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
  const app = express();
  lookups = [];
  app.get('/api/ready', (_req, res) => res.type('text/event-stream').send('event: phase\ndata: {"phase":"ready"}\n\n'));
  app.use('/api/search', (req, _res, next) => { lookups.push({ ...req.query }); next(); });
  new SearchRoutes(manager).setupRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  environment = {
    ...process.env,
    CMEM_NOTES_DIR: notes,
    CMEM_NOTE_PATTERN: 'timeout',
    CLAUDE_MEM_DATA_DIR: join(root, 'data'),
    CLAUDE_CONFIG_DIR: join(root, 'native-config'),
    CLAUDE_MEM_WORKER_URL: `http://127.0.0.1:${port}`,
    CLAUDE_MEM_WORKER_AUTOSTART: 'false',
    CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_TELEMETRY: '0',
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED: 'true',
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'false',
    CLAUDE_MEM_MEMORY_WATCH_ROOTS: JSON.stringify([{ path: notes, project }]),
  };
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

function rawInput(command: string | string[]) {
  return { session_id: 'owned-session', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
}

async function child(args: string[], input = '') {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: repo, env: environment, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' });
  return JSON.parse(stdout.trim());
}

async function normalize(command: string | string[]) {
  return child(['--eval', `const {codexAdapter}=await import(${JSON.stringify(adapterPath)}); console.log(JSON.stringify(codexAdapter.normalizeInput(${JSON.stringify(rawInput(command))})));`]);
}

// These are POSIX shell commands; Windows PowerShell has a different environment syntax.
describe.skipIf(process.platform === 'win32')('inherited shell environment reaches memory context', () => {
  it('attributes the file read by a double-quoted environment path in the real Codex adapter', async () => {
    const command = 'cat "${CMEM_NOTES_DIR}/feedback.md"';
    expect(execFileSync('sh', ['-c', command], { cwd: root, env: environment, encoding: 'utf8' })).toBe('timeout preference\n');
    const normalized = await normalize(command);
    expect(normalized.toolInput.filePaths).toEqual([file]);
  });

  it.each([
    ['cat "$CMEM_NOTES_DIR/feedback.md"', 'feedback'],
    ['grep "$CMEM_NOTE_PATTERN" "${CMEM_NOTES_DIR}/feedback.md"', 'timeout'],
  ])('retrieves saved index rows for %s', async (command, query) => {
    expect(execFileSync('sh', ['-c', command], { cwd: root, env: environment, encoding: 'utf8' })).toBe('timeout preference\n');
    const output = await child([workerEntry, 'hook', 'codex', 'file-context'], JSON.stringify(rawInput(command)));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatchObject({ query, project, platformSource: 'codex', type: 'observations', format: 'json' });
    const context = output.hookSpecificOutput?.additionalContext;
    expect(context).toContain(title);
    expect(context).toContain(String(observationId));
    expect(context).not.toContain('PRIVATE_FULL_RECORD');
  });

  it('keeps single quotes, escaped dollars and direct argv operands literal', async () => {
    const literal = '$CMEM_NOTES_DIR/feedback.md';
    for (const command of ["cat '$CMEM_NOTES_DIR/feedback.md'", 'cat \\$CMEM_NOTES_DIR/feedback.md']) {
      expect(execFileSync('sh', ['-c', command], { cwd: root, env: environment, encoding: 'utf8' })).toBe('literal dollar path\n');
      expect((await normalize(command)).toolInput.filePaths).toEqual([literal]);
    }
    expect(execFileSync('cat', [literal], { cwd: root, env: environment, encoding: 'utf8' })).toBe('literal dollar path\n');
    expect((await normalize(['cat', literal])).toolInput.filePaths).toEqual([literal]);
  });
});
