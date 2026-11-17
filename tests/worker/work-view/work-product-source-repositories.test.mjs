import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProducts, productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const UNKNOWN = 'c'.repeat(40);
const call = (id, command, stdout) => ({ id, tool_name: 'Bash', tool_input: JSON.stringify({ command }),
  tool_response: JSON.stringify({ stdout, stderr: '' }), created_at_epoch: id });
const commits = () => productsFromToolUse(call(1,
  "git -C first commit -m 'First' && git -C second commit -m 'Second' && git -C third commit -m 'Third'",
  `[detached HEAD ${FIRST}] First\n[detached HEAD ${SECOND}] Second\n[detached HEAD ${UNKNOWN}] Third\n`));
const push = (id, sha, repo) => productsFromToolUse(call(id, `git push https://github.com/${repo}.git HEAD:feature`,
  `To https://github.com/${repo}.git\n   1111111..${sha}  HEAD -> feature\n`));

test('a command touching different repositories does not invent a URL for an unassigned commit', () => {
  for (const pushes of [
    [push(2, FIRST, 'owner/first'), push(3, SECOND, 'owner/second')],
    [push(3, SECOND, 'owner/second'), push(2, FIRST, 'owner/first')],
  ]) {
    const products = mergeProducts([commits(), ...pushes]);
    assert.equal(products.find(product => product.sha === FIRST).url, `https://github.com/owner/first/commit/${FIRST}`);
    assert.equal(products.find(product => product.sha === SECOND).url, `https://github.com/owner/second/commit/${SECOND}`);
    assert.equal(products.find(product => product.sha === UNKNOWN).url, undefined);
  }
});

test('unambiguous source evidence still links earlier commits from the same command', () => {
  const products = mergeProducts([commits(), push(2, FIRST, 'owner/repo'), push(3, SECOND, 'owner/repo')]);
  assert.equal(products.find(product => product.sha === UNKNOWN).url, `https://github.com/owner/repo/commit/${UNKNOWN}`);
});

test('repository evidence from another tool call does not fill an unassigned commit', () => {
  const unknown = productsFromToolUse(call(4, "git commit -m 'Third'", `[detached HEAD ${UNKNOWN}] Third\n`));
  const products = mergeProducts([commits().filter(product => product.sha !== UNKNOWN), unknown,
    push(2, FIRST, 'owner/first'), push(3, SECOND, 'owner/second')]);
  assert.equal(products.find(product => product.sha === UNKNOWN).url, undefined);
});
