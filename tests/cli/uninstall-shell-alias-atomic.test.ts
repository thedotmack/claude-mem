import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { findLegacyClaudeMemAlias, stripLegacyClaudeMemAlias, stripLegacyClaudeMemAliasUnlessSkipped } from '../../src/npx-cli/commands/uninstall.js';

// The shell rc a user already has open in an editor is not a file an uninstall
// may truncate. The alias strip read the whole file and wrote the whole file
// back with a plain writeFileSync, so a crash or a power loss in the window
// left a half-written .bashrc and a broken login shell. The shared helper
// writes its bytes to a temp file in the same directory, fsyncs, then renames
// over the target: a replacement lands as a new inode, which is what the second
// test measures. This is the same shape the earlier installer conversions use.
describe('uninstall strips the legacy shell alias atomically', () => {
  let home: string;
  let bashrc: string;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'uninstall-alias-'));
    bashrc = path.join(home, '.bashrc');
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  const aliasLine = 'alias claude-mem="npx claude-mem@latest"';
  const keep = ['export EDITOR=vim', 'alias gs="git status"', 'alias ll="ls -la"'];

  it('removes only the alias line and keeps every other line', () => {
    writeFileSync(bashrc, [keep[0], aliasLine, keep[1], keep[2], ''].join('\n'), 'utf-8');

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe([keep[0], keep[1], keep[2], ''].join('\n'));
  });

  it('leaves a file without the alias untouched, inode included', () => {
    writeFileSync(bashrc, [keep[0], keep[1], ''].join('\n'), 'utf-8');
    const before = statSync(bashrc);

    stripLegacyClaudeMemAlias(home);

    const after = statSync(bashrc);
    expect(readFileSync(bashrc, 'utf-8')).toBe([keep[0], keep[1], ''].join('\n'));
    expect(after.ino).toBe(before.ino);
  });

  it('replaces the rewritten file instead of editing it in place', () => {
    writeFileSync(bashrc, [keep[0], aliasLine, keep[1], ''].join('\n'), 'utf-8');
    const before = statSync(bashrc);

    stripLegacyClaudeMemAlias(home);

    const after = statSync(bashrc);
    expect(after.ino).not.toBe(before.ino);
  });
});

// Detection is what `doctor` reports and what `install`/`update` act on
// (#6228): the same alias line, found read-only, in the same candidate files.
describe('findLegacyClaudeMemAlias', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'find-alias-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const aliasLine = 'alias claude-mem=\'bun "~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs"\'';

  it('returns nothing when no rc file exists', () => {
    expect(findLegacyClaudeMemAlias(home)).toEqual([]);
  });

  it('returns nothing for other aliases or a commented-out claude-mem alias', () => {
    writeFileSync(path.join(home, '.bashrc'), ['alias gs="git status"', `# ${aliasLine}`, ''].join('\n'), 'utf-8');
    expect(findLegacyClaudeMemAlias(home)).toEqual([]);
  });

  it('names each rc file carrying the alias, indented lines included', () => {
    const bashrc = path.join(home, '.bashrc');
    const zshrc = path.join(home, '.zshrc');
    writeFileSync(bashrc, [aliasLine, ''].join('\n'), 'utf-8');
    writeFileSync(zshrc, ['export EDITOR=vim', `  ${aliasLine}`, ''].join('\n'), 'utf-8');

    expect(findLegacyClaudeMemAlias(home)).toEqual([
      { filePath: bashrc, spansMultipleLines: false },
      { filePath: zshrc, spansMultipleLines: false },
    ]);
  });

  it('leaves the files it reads untouched', () => {
    const bashrc = path.join(home, '.bashrc');
    const content = [aliasLine, ''].join('\n');
    writeFileSync(bashrc, content, 'utf-8');

    findLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe(content);
  });

  it('still names a file whose alias definition spans multiple lines, and marks it', () => {
    const bashrc = path.join(home, '.bashrc');
    writeFileSync(bashrc, [
      "alias claude-mem='bun ~/.claude/plugins/marketplaces/",
      "thedotmack/plugin/scripts/worker-service.cjs'",
      '',
    ].join('\n'), 'utf-8');

    expect(findLegacyClaudeMemAlias(home)).toEqual([{ filePath: bashrc, spansMultipleLines: true }]);
  });
});

// A multiline alias definition is valid shell: the quote opened on the
// alias line closes on a later line. Deleting only the opening line — what
// a line filter does — leaves the rest of the command and the closing
// quote behind, and the user's next shell reads a broken rc file. The
// strip therefore leaves any file carrying such a definition completely
// untouched; `doctor` still reports the file so the alias gets removed by
// hand instead.
describe('stripLegacyClaudeMemAlias leaves multiline alias definitions untouched', () => {
  let home: string;
  let bashrc: string;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'strip-alias-multiline-'));
    bashrc = path.join(home, '.bashrc');
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not rewrite a file whose alias opens a single quote it closes on a later line', () => {
    const content = [
      'export EDITOR=vim',
      "alias claude-mem='bun ~/.claude/plugins/marketplaces/",
      "thedotmack/plugin/scripts/worker-service.cjs'",
      'alias ll="ls -la"',
      '',
    ].join('\n');
    writeFileSync(bashrc, content, 'utf-8');
    const before = statSync(bashrc);

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe(content);
    expect(statSync(bashrc).ino).toBe(before.ino);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not rewrite a file whose alias opens a double quote it closes on a later line', () => {
    const content = [
      'alias claude-mem="bun ~/.claude/plugins/marketplaces/',
      'thedotmack/plugin/scripts/worker-service.cjs"',
      '',
    ].join('\n');
    writeFileSync(bashrc, content, 'utf-8');

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe(content);
  });

  it('does not rewrite a file whose alias line ends in a continuation backslash', () => {
    const content = [
      "alias claude-mem='bun worker-service.cjs' \\",
      '  --verbose',
      '',
    ].join('\n');
    writeFileSync(bashrc, content, 'utf-8');

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe(content);
  });

  it('still strips a single-line alias from another rc file in the same run', () => {
    const zshrc = path.join(home, '.zshrc');
    const multiline = [
      "alias claude-mem='bun ~/.claude/plugins/marketplaces/",
      "thedotmack/plugin/scripts/worker-service.cjs'",
      '',
    ].join('\n');
    writeFileSync(bashrc, multiline, 'utf-8');
    writeFileSync(zshrc, ['alias claude-mem="npx claude-mem@latest"', 'export EDITOR=vim', ''].join('\n'), 'utf-8');

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe(multiline);
    expect(readFileSync(zshrc, 'utf-8')).toBe(['export EDITOR=vim', ''].join('\n'));
  });

  it('still strips a single-line alias whose value carries escaped quotes', () => {
    writeFileSync(bashrc, ['alias claude-mem="bun \\"worker-service.cjs\\""', 'export EDITOR=vim', ''].join('\n'), 'utf-8');

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe(['export EDITOR=vim', ''].join('\n'));
  });
});

// The strip is a side effect on the user's own shell files, so on an
// interactive reinstall it must run only after the "Overwrite existing
// installation?" confirmation: answering No (or cancelling) exits the
// command, and a cancelled install must not have rewritten anything.
// Asserted on the source, the same way install-error-matrix.test.ts pins
// the clearLastInstallError ordering — the full interactive install flow
// is not drivable from a unit test.
describe('install strips the legacy alias only after the overwrite confirmation', () => {
  it('places the strip call after the confirmation prompt in install.ts', () => {
    const source = readFileSync(path.join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');
    const promptIndex = source.indexOf('Overwrite existing installation?');
    const stripIndex = source.indexOf('stripLegacyClaudeMemAliasUnlessSkipped(');

    expect(promptIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeGreaterThan(promptIndex);
  });
});

describe('install and update honor CLAUDE_MEM_SKIP_SHELL_RC for the legacy alias', () => {
  let home: string;
  let bashrc: string;
  const aliasLine = 'alias claude-mem="npx claude-mem@latest"';
  const content = ['export EDITOR=vim', aliasLine, ''].join('\n');

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'install-alias-skip-'));
    bashrc = path.join(home, '.bashrc');
    writeFileSync(bashrc, content, 'utf-8');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('leaves the file untouched and names it when the variable is set', () => {
    const warnings: string[] = [];
    stripLegacyClaudeMemAliasUnlessSkipped({
      home,
      environmentVariables: { CLAUDE_MEM_SKIP_SHELL_RC: '1' },
      warn: (message) => warnings.push(message),
    });

    expect(readFileSync(bashrc, 'utf-8')).toBe(content);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(bashrc);
    expect(warnings[0]).toContain('CLAUDE_MEM_SKIP_SHELL_RC');
  });

  it('still strips the alias when the variable is not set', () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const warnings: string[] = [];
    stripLegacyClaudeMemAliasUnlessSkipped({ home, environmentVariables: {}, warn: (message) => warnings.push(message) });
    errorSpy.mockRestore();

    expect(readFileSync(bashrc, 'utf-8')).toBe('export EDITOR=vim\n');
    expect(warnings).toHaveLength(0);
  });
});
