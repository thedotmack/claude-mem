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
    { command: 'rg', flags: ['-d', '1'], pattern: 'timeout', positional: true },
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

  it('leaves a search outside configured memory roots alone', () => {
    expect(memorySearchLookup({ sessionId: 'pattern-fixture', cwd: '/project', toolName: 'Bash',
      toolInput: { command: "rg --glob '*.md' timeout /project/src" } }, ['/notes'])).toBeNull();
  });
});
