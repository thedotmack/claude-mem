import test from 'node:test';
import assert from 'node:assert/strict';
import { gitProductsFromCommand, mergeProducts } from '../../../src/services/work-view/work-product.mjs';

const repo = 'https://github.com/acme/demo.git';
const update = '   abcdef0..bcdef01  main -> main';

test('a dry-run transcript cannot publish a branch or link a local commit', () => {
  const rows = gitProductsFromCommand(`git commit -m x && git push -n ${repo} main`, {},
    `[main bcdef01] x\nTo ${repo}\n${update}`);
  assert.deepEqual(rows.map(p => [p.kind, p.url]), [['commit', undefined]]);
});

test('a successful no-op push adds no work product', () => {
  assert.deepEqual(gitProductsFromCommand(`git push ${repo} main`, {}, 'Everything up-to-date'), []);
});

test('pushing an explicit tag does not invent a branch named refs/tags/v1', () => {
  assert.deepEqual(gitProductsFromCommand(`git push ${repo} refs/tags/v1`, {}, `To ${repo}\n * [new tag] v1 -> v1`), []);
});

test('porcelain output identifies every changed branch by its destination ref', () => {
  const output = `To ${repo}\n*\trefs/heads/a:refs/heads/customer/a\t[new branch]\n+\trefs/heads/b:refs/heads/customer/b\tabcdef0...bcdef01 (forced update)\n=\trefs/heads/c:refs/heads/c\t[up to date]\nDone`;
  const items = gitProductsFromCommand('git push --porcelain origin --all', {}, output);
  assert.deepEqual(items.map(p => [p.branch, p.repo]), [['customer/a','acme/demo'],['customer/b','acme/demo']]);
});

test('a branch name containing # or a literal percent maps to the right GitHub path', () => {
  const [item] = gitProductsFromCommand(`git push ${repo} HEAD:fix/a#b%23c`, {}, '');
  assert.equal(item.url, 'https://github.com/acme/demo/tree/fix/a%23b%2523c');
});

test('same-named branches pushed to different repositories retain both destinations', () => {
  const second = 'https://github.com/other/demo.git';
  const items = gitProductsFromCommand(`git push ${repo} main && git push ${second} main`, {},
    `To ${repo}\n${update}\nTo ${second}\n${update}`);
  assert.deepEqual(mergeProducts([items]).map(p=>p.repo).sort(), ['acme/demo','other/demo']);
});

test('a no-op push before a simulated push does not make the simulation look real', () => {
  const cmd = `git push ${repo} main && git push -n ${repo} feature`;
  const out = `Everything up-to-date\nTo ${repo}\n * [new branch] feature -> feature`;
  assert.deepEqual(gitProductsFromCommand(cmd, {}, out), []);
});

test('a combined tag and branch push retains the changed branch', () => {
  const out = `To ${repo}\n${update}\n * [new tag] v1 -> v1`;
  const rows = gitProductsFromCommand(`git push ${repo} main --tags`, {}, out);
  assert.deepEqual(rows.map(row => row.branch), ['main']);
});
