import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKILLS = join(import.meta.dir, '..', '..', 'plugin', 'skills');

// Skill scripts run on the user's plain `python3`, which can be 3.9-3.11.
// Those versions reject a backslash inside an f-string expression; 3.12+ accepts it,
// so on a newer interpreter the tokenizer is used to find the same construct.
const CHECK = String.raw`
import sys, tokenize
path = sys.argv[1]
if sys.version_info < (3, 12):
    compile(open(path, encoding="utf-8").read(), path, "exec")
    sys.exit(0)
depth = 0
with open(path, "rb") as handle:
    for token in tokenize.tokenize(handle.readline):
        if token.type == tokenize.FSTRING_START: depth += 1
        elif token.type == tokenize.FSTRING_END: depth -= 1
        elif depth and token.type != tokenize.FSTRING_MIDDLE and "\\" in token.string:
            print(f"{path}:{token.start[0]}: backslash in an f-string expression")
            sys.exit(1)
`;

function pythonScripts(): string[] {
  return readdirSync(SKILLS, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.py'))
    .map((file) => join(SKILLS, file));
}

describe('skill Python scripts', () => {
  it('finds the scripts to check', () => {
    expect(pythonScripts().some((file) => file.endsWith('save_goals.py'))).toBe(true);
  });

  for (const script of pythonScripts()) {
    it(`parses on Python 3.9-3.11: ${script.slice(SKILLS.length + 1)}`, () => {
      const result = Bun.spawnSync(['python3', '-c', CHECK, script]);
      expect(result.stdout.toString() + result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
    });
  }
});

describe('save_goals.py', () => {
  it('drops quotes that aged out of the prompts window, and items left without one, but still refuses invented quotes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-goals-'));
    try {
      writeFileSync(join(dir, 'owner-prompts.md'), '# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nship the cards today\n');
      const save = (goals: unknown) => {
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
        return Bun.spawnSync(['python3', join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--dry-run']);
      };
      const result = save({ priorities: [
        { rank: 1, title: 'Cards', evidence: [{ at: '2026-10-20 10:00', quote: 'ship the cards' }, { at: '2026-09-01 09:00', quote: 'aged out' }] },
        { rank: 2, title: 'Old', evidence: [{ at: '2026-09-02 09:00', quote: 'older words' }] },
      ] });
      expect(result.exitCode).toBe(0);
      const writes = JSON.parse(result.stdout.toString()).writes;
      expect(writes.slice(1).map((write: { task: string; evidence: string }) => [write.task, write.evidence])).toEqual([['Priority: Cards', '2026-10-20 10:00 | ship the cards']]);
      expect(save({ priorities: [{ title: 'Made up', evidence: [{ at: '2026-10-20 10:00', quote: 'never typed' }] }] }).exitCode).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('clears the goals when every saved quote has aged out, instead of refusing to save forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-goals-'));
    try {
      const save = (prompts: string, goals: unknown) => {
        writeFileSync(join(dir, 'owner-prompts.md'), prompts);
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
        return Bun.spawnSync(['python3', join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--dry-run']);
      };
      const aged = { generated_at: '2026-10-20T10:00:00Z', priorities: [{ rank: 1, title: 'Old', evidence: [{ at: '2026-09-02 09:00', quote: 'older words' }] }] };
      // Newer prompts exist, but none was quoted: the saved goal's only quote is older than the window.
      const later = save('# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nunrelated words\n', aged);
      expect(later.stderr.toString()).toBe('');
      expect(later.exitCode).toBe(0);
      const output = JSON.parse(later.stdout.toString());
      expect(output.writes).toHaveLength(1);
      expect(output.writes[0]).toMatchObject({ generated_at: '2026-10-20T10:00:00Z', status: 'open' });
      // No prompts in the window at all: every quote is outside it.
      expect(save('# Owner prompts\n', aged).exitCode).toBe(0);
      expect(save('# Owner prompts\n', { priorities: [] }).exitCode).toBe(0);
      // An answer with no goals at all, while prompts exist, is still refused.
      expect(save('# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nunrelated words\n', { priorities: [] }).exitCode).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
