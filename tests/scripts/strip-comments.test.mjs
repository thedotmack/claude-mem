import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/strip-comments.ts', import.meta.url));
test('strips tracked comments without rewriting unrelated bytes or consuming executable syntax', t => {
  const dir = mkdtempSync(join(tmpdir(), 'strip-comments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const cases = [
    [' leading-é.md', '<!-- removed -->\r\nkept\r\n', 'kept\r\n'],
    ['literal.js', 'const s = `a\n\n\nb`;\n// removed\n', 'const s = `a\n\n\nb`;\n'],
    ['tokens.js', 'let x = 1 +/* gap */+ 2;\n', 'let x = 1 + + 2;\n'],
    ['asi.js', 'function f(){ return /*line\nbreak*/ 1; }\n', 'function f(){ return \n 1; }\n'],
    ['directives.js', '/* @license MIT */\n// discarded\n//# sourceMappingURL=map.js\n', '/* @license MIT */\n//# sourceMappingURL=map.js\n'],
    ['license.js', '/**\n * Package notice.\n * @license MIT\n */\n// discarded\n', '/**\n * Package notice.\n * @license MIT\n */\n'],
    ['preserve.js', '/**\r\n * @preserve original terms\r\n */\r\n', '/**\r\n * @preserve original terms\r\n */\r\n'],
    ['island.md', '<!--before-->important<!--after-->\n', '<!--before-->important<!--after-->\n'],
    ['expressions.mdx', '{/* before */ 42 /* after */}\n\n{/* discarded */}\n', '{/* before */ 42 /* after */}\n\n'],
    ['template.html', '<template><!--remove--><b>text</b></template>\n', '<template><b>text</b></template>\n'],
    ['directives.html', '<!--#include virtual="/one" -->\n<!--[if IE]>text<![endif]-->\n<!-- remove -->\n',
      '<!--#include virtual="/one" -->\n<!--[if IE]>text<![endif]-->\n'],
    ['.gitignore', '# removed\nproject #1\n', 'project #1\n'],
  ];
  cases.push(['plain.md', 'before\n\n\n\nafter\n', 'before\n\n\n\nafter\n']);
  if (process.platform !== 'win32') cases.push(['line\nbreak.md', '<!-- removed -->\nkept\n', 'kept\n']);
  cases.push(['stats.md', '<!-- 多字节 -->\ntext\n', 'text\n']);
  for (const [name, input] of cases) writeFileSync(join(root, name), input);
  const undecodable = Buffer.from([47, 47, 32, 255, 10, 49, 10]);
  writeFileSync(join(root, 'legacy.js'), undecodable);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (process.platform !== 'win32') {
    writeFileSync(join(dir, 'outside.js'), '// preserve\n42;\n');
    symlinkSync('../outside.js', join(root, 'link.js'));
    mkdirSync(join(root, 'old'));
    writeFileSync(join(root, 'old', 'behind.js'), '// tracked\n');
  }
  execFileSync('git', ['add', '-f', '.'], { cwd: root });
  if (process.platform !== 'win32') {
    rmSync(join(root, 'old'), { recursive: true });
    writeFileSync(join(dir, 'behind.js'), '// external\n');
    symlinkSync('..', join(root, 'old'));
  }
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const changed = cases.filter(([, before, after]) => before !== after);
  const bytes = index => changed.reduce((total, row) => total + Buffer.byteLength(row[index]), 0);
  assert.ok(result.stdout.includes(`Bytes:     ${bytes(1)} -> ${bytes(2)}`), result.stdout);
  for (const [name, , expected] of cases) assert.equal(readFileSync(join(root, name), 'utf8'), expected, name);
  assert.deepEqual(readFileSync(join(root, 'legacy.js')), undecodable);
  if (process.platform !== 'win32') {
    assert.equal(readFileSync(join(dir, 'outside.js'), 'utf8'), '// preserve\n42;\n');
    assert.equal(readFileSync(join(dir, 'behind.js'), 'utf8'), '// external\n');
  }
});

test('skips undecodable Git paths without touching an untracked UTF-8 namesake', {
  skip: process.platform === 'win32',
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'strip-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rawPath = Buffer.concat([Buffer.from(join(root, 'bad-')), Buffer.from([0xff]), Buffer.from('.js')]);
  const namesake = join(root, 'bad-\uFFFD.js');
  const contents = '// keep\n42;\n';
  try {
    writeFileSync(rawPath, contents);
  } catch (error) {
    // APFS (macOS) refuses file names that are not valid UTF-8, so the case cannot be set up there.
    if (error.code === 'EILSEQ') return t.skip('filesystem rejects non-UTF-8 file names');
    throw error;
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  writeFileSync(namesake, contents);

  execFileSync(process.execPath, [script, root]);
  assert.equal(readFileSync(rawPath, 'utf8'), contents);
  assert.equal(readFileSync(namesake, 'utf8'), contents);
});
