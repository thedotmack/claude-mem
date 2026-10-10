import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { memorySearchLookup } from '../../src/cli/handlers/memory-search.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('Bash memory lookup uses the native search pattern', () => {
  const cases: Array<{ command: string; flags: string[]; pattern: string; positional: boolean; bsdOnly?: boolean }> = [
    { command: 'rg', flags: ['--glob', '*.md'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['-g', '*.md'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['--max-count', '1'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['-nm', '1'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['--regexp=timeout'], pattern: 'timeout', positional: false },
    { command: 'rg', flags: ['-etimeout'], pattern: 'timeout', positional: false },
    { command: 'rg', flags: ['--'], pattern: '-timeout', positional: true },
    { command: 'grep', flags: ['-m', '1'], pattern: 'timeout', positional: true },
    { command: 'grep', flags: ['--regexp=timeout'], pattern: 'timeout', positional: false },
    { command: 'rg', flags: ['-M', '1000'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['--max-depth', '1'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['--regex-size-limit', '10M'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['--field-match-separator', '::'], pattern: 'timeout', positional: true },
    { command: 'grep', flags: ['-d', 'skip'], pattern: 'timeout', positional: true },
    { command: 'grep', flags: ['--binary-files', 'text'], pattern: 'timeout', positional: true },
    { command: 'grep', flags: ['--context'], pattern: 'timeout', positional: true, bsdOnly: true },
    { command: 'grep', flags: ['--context=2'], pattern: 'timeout', positional: true },
    { command: 'rg', flags: ['-m1'], pattern: 'timeout', positional: true },
    { command: 'grep', flags: ['-e', 'timeout'], pattern: 'timeout', positional: false },
    { command: 'rg', flags: [], pattern: 'timeout', positional: true },
  ];

  for (const fixture of cases) {
    it.skipIf(!Bun.which(fixture.command) || (Boolean(fixture.bsdOnly) && !Bun.spawnSync(['grep', '--version']).stdout.toString().includes('BSD grep')))(`${fixture.command} ${fixture.flags.join(' ')} preserves its pattern`, () => {
      const root = mkdtempSync(path.join(tmpdir(), 'cmem-pattern-'));
      directories.push(root);
      const notes = path.join(root, 'notes');
      mkdirSync(notes);
      const file = path.join(notes, 'feedback.md');
      writeFileSync(file, '-timeout preference\n');
      const args = [...fixture.flags, ...(fixture.positional ? [fixture.pattern] : []), file];
      // Execute the real search binary before checking the hook's interpretation.
      const native = Bun.spawnSync([fixture.command, ...args], { stdout: 'pipe', stderr: 'pipe' });
      expect(native.exitCode).toBe(0);
      expect(native.stdout.toString()).toContain('-timeout preference');
      expect(native.stderr.toString()).toBe('');
      const command = [fixture.command, ...args].map(value => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
      expect(memorySearchLookup({ sessionId: 'pattern-fixture', cwd: root, toolName: 'Bash', toolInput: { command } }, [notes]))
        .toEqual({ query: fixture.pattern, memoryPath: file });
    });
  }

  it('recognizes the newer ripgrep short depth option without requiring native support', () => {
    for (const depth of ['-d 1', '-d1']) {
      expect(memorySearchLookup({ sessionId: 'pattern-fixture', cwd: '/project', toolName: 'Bash',
        toolInput: { command: `rg ${depth} timeout /notes/feedback.md` } }, ['/notes']))
        .toEqual({ query: 'timeout', memoryPath: '/notes/feedback.md' });
    }
  });

  it.skipIf(!Bun.which('rg'))('keeps first-pattern supplementation separate from native OR results', async () => {
    const { default: express } = await import('express');
    const { SessionStore } = await import('../../src/services/sqlite/SessionStore.js');
    const { SessionSearch } = await import('../../src/services/sqlite/SessionSearch.js');
    const { SearchManager } = await import('../../src/services/worker/SearchManager.js');
    const { FormattingService } = await import('../../src/services/worker/FormattingService.js');
    const { TimelineService } = await import('../../src/services/worker/TimelineService.js');
    const { SearchRoutes } = await import('../../src/services/worker/http/routes/SearchRoutes.js');
    const { ModeManager } = await import('../../src/services/domain/ModeManager.js');
    ModeManager.getInstance().loadMode('code');
    const root = mkdtempSync(path.join(tmpdir(), 'cmem-pattern-retrieval-'));
    directories.push(root);
    const notes = path.join(root, 'notes'); mkdirSync(notes);
    const file = path.join(notes, 'feedback.md');
    writeFileSync(file, 'timeout deadline policy\nretry backoff policy\n');
    const store = new SessionStore(path.join(root, 'owned.db'), { syncOpsEnabled: false });
    const fixtures = [
      { project: 'pattern-project', title: 'timeout deadline policy', narrative: 'Increase deadline thirty seconds' },
      { project: 'pattern-project', title: 'retry backoff policy', narrative: 'Use exponential backoff' },
      { project: 'other-project', title: 'timeout retry policy', narrative: 'Apply both safeguards' },
    ];
    const app = express(); app.use(express.json());
    const server = app.listen(0, '127.0.0.1');
    try {
      for (const [index, fixture] of fixtures.entries()) {
        const id = store.createSDKSession(`pattern-host-${index}`, fixture.project, 'owned prompt');
        const memoryId = `pattern-memory-${index}`; store.updateMemorySessionId(id, memoryId);
        store.storeObservation(memoryId, fixture.project, { type: 'decision', title: fixture.title,
          subtitle: null, narrative: fixture.narrative, facts: [], concepts: [], files_read: [], files_modified: [] });
      }
      new SearchRoutes(new SearchManager(new SessionSearch(store.db), store, null,
        new FormattingService(), new TimelineService())).setupRoutes(app);
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned search server did not bind');
      const search = async (query: string, project = 'pattern-project') => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/mem-search`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, mode: 'auto', project, projects: [project], searchScope: project, limit: 8 }),
        });
        expect(response.status).toBe(200);
        const result = await response.json() as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).not.toBe(true);
        return result.content.map(item => item.text).join('\n');
      };
      // The real single-query backend uses conjunction, so joining alternatives loses both records.
      const joined = await search('timeout retry');
      expect(joined).not.toContain('timeout deadline policy');
      expect(joined).not.toContain('retry backoff policy');
      expect(await search('timeout retry', 'other-project')).toContain('timeout retry policy');
      for (const [first, second, expected, omitted] of [
        ['timeout', 'retry', 'timeout deadline policy', 'retry backoff policy'],
        ['retry', 'timeout', 'retry backoff policy', 'timeout deadline policy'],
      ]) {
        const args = ['-e', first, '--regexp=' + second, file];
        const native = Bun.spawnSync(['rg', ...args], { stdout: 'pipe', stderr: 'pipe' });
        expect(native.exitCode).toBe(0);
        expect(native.stderr.toString()).toBe('');
        expect(native.stdout.toString().trim().split('\n').sort())
          .toEqual(['retry backoff policy', 'timeout deadline policy']);
        const command = ['rg', ...args].map(value => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
        const lookup = memorySearchLookup({ sessionId: 'pattern-fixture', cwd: root, toolName: 'Bash', toolInput: { command } }, [notes]);
        const supplemental = await search(lookup!.query);
        expect(supplemental).toContain(expected);
        expect(lookup?.query).toBe(first);
        // Preserve the existing first-pattern limit; this is not a union search feature.
        expect(supplemental).not.toContain(omitted);
        expect(supplemental).not.toContain('timeout retry policy');
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  });

  it('leaves a search outside configured memory roots alone', () => {
    expect(memorySearchLookup({ sessionId: 'pattern-fixture', cwd: '/project', toolName: 'Bash',
      toolInput: { command: "rg --glob '*.md' timeout /project/src" } }, ['/notes'])).toBeNull();
  });
});
