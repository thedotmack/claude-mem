import { expect, test } from 'bun:test';
import { mergeProducts, productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const FIRST = `abc1234a${'1'.repeat(32)}`;
const SECOND = `abc1234b${'2'.repeat(32)}`;
const call = (id, command, stdout, at = id) => ({ id, tool_name: 'Bash', tool_input: JSON.stringify({ command }),
  tool_response: JSON.stringify({ stdout, stderr: '' }), created_at_epoch: at });
const commit = (id, sha, subject = 'Change') => productsFromToolUse(call(id, `git commit -m '${subject}'`, `[detached HEAD ${sha}] ${subject}\n`));
const pushed = (id, sha, repo) => productsFromToolUse(call(id, `git push https://github.com/${repo}.git HEAD:feature`, `To https://github.com/${repo}.git\n   1111111..${sha}  HEAD -> feature\n`));

test('different recorded commits that share seven hex digits remain separate products', () => {
  const products = mergeProducts([commit(1, FIRST, 'First change'), commit(2, SECOND, 'Second change')]);
  expect(products.map(product => product.sha)).toEqual([SECOND, FIRST]);
  expect(products.map(product => product.sourceRef.id)).toEqual([2, 1]);
});

test('two commits made by one command are not collapsed by their display abbreviations', () => {
  const products = productsFromToolUse(call(1, "git commit -m 'First change' && git commit -m 'Second change'",
    `[main ${FIRST}] First change\n[main ${SECOND}] Second change\n`));
  expect(products.map(product => [product.sha, product.title])).toEqual([
    [FIRST, 'abc1234 First change'], [SECOND, 'abc1234 Second change'],
  ]);
});

test('a matching full push head links to its own repository regardless of a colliding later head', () => {
  const firstPush = pushed(2, FIRST, 'owner/first');
  const otherPush = pushed(3, SECOND, 'owner/second');
  for (const pushes of [[firstPush, otherPush], [otherPush, firstPush]]) {
    const product = mergeProducts([commit(1, FIRST), ...pushes]).find(product => product.kind === 'commit');
    expect(product.url).toBe(`https://github.com/owner/first/commit/${FIRST}`);
  }
});

test('only an unambiguous abbreviation is folded into the longer recorded identity', () => {
  const unique = mergeProducts([commit(1, FIRST), commit(2, FIRST.slice(0, 9))]);
  expect(unique.map(product => product.sha)).toEqual([FIRST]);
  const ambiguous = mergeProducts([commit(1, FIRST), commit(2, SECOND), commit(3, FIRST.slice(0, 7))]);
  expect(ambiguous.map(product => product.sha)).toEqual([FIRST.slice(0, 7), SECOND, FIRST]);
  const unknown = mergeProducts([commit(1, FIRST.slice(0, 7)), pushed(2, FIRST, 'owner/first'), pushed(3, SECOND, 'owner/second')]);
  expect(unknown.find(product => product.kind === 'commit').url).toBeUndefined();
  const shortHead = mergeProducts([commit(1, FIRST), commit(2, SECOND), commit(3, FIRST.slice(0, 7)), pushed(4, FIRST.slice(0, 7), 'owner/first')]);
  expect(shortHead.filter(product => product.kind === 'commit').map(product => product.url)).toEqual([undefined, undefined, undefined]);
});
