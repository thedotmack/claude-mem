import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const publish = (tool_response) => productsFromToolUse({
  id: 1, tool_name: 'Artifact', tool_input: '{}', tool_response,
});

test('deeply nested publishing results keep their artifact link without overflowing the stack', () => {
  const depth = 20000;
  const response = '{"result":'.repeat(depth) + '{"url":"https://example.com/artifact"}' + '}'.repeat(depth);
  assert.equal(publish(response)[0].url, 'https://example.com/artifact');
});

test('nested publishing links retain depth-first source order and URL field filtering', () => {
  const result = publish({
    text: 'https://example.com/not-a-product',
    nested: [{ url: 'https://example.com/api/internal' }, { pageUrl: 'https://example.com/first' }],
    url: 'https://example.com/second',
  });
  assert.equal(result[0].url, 'https://example.com/first');
});

test('cyclic objects and arrays retain their artifact link within a bounded runtime', () => {
  // A test timeout cannot interrupt a synchronous loop, so isolate traversal in
  // a child process that the parent can terminate if the cycle guard regresses.
  const moduleUrl = new URL('../../../src/services/work-view/work-product.mjs', import.meta.url).href;
  const result = spawnSync('node', ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { productsFromToolUse } from ${JSON.stringify(moduleUrl)};

    const object = {};
    object.self = object;
    object.url = 'https://example.com/artifact';
    const array = [];
    array.push(array, { url: 'https://example.com/artifact' });

    for (const response of [object, array]) {
      const products = productsFromToolUse({
        id: 1, tool_name: 'Artifact', tool_input: '{}', tool_response: response,
      });
      assert.equal(products[0].url, 'https://example.com/artifact');
    }
  `], { encoding: 'utf8', timeout: 5000 });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
