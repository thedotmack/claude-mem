import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { platformLabel } from '../../../src/services/work-view/agent-view.mjs';

test('live Gemini CLI sessions (`gemini`) and imported ones (`gemini-cli`) show as one host', () => {
  assert.equal(platformLabel('gemini'), 'Gemini CLI');
  assert.equal(platformLabel('gemini'), platformLabel('gemini-cli'));
  assert.equal(platformLabel('some-new-host'), 'some-new-host');
  assert.equal(platformLabel(null), 'Unassigned');
});
