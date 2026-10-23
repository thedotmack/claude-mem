import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
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
