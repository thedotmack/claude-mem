import test from 'node:test';
import assert from 'node:assert/strict';
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
