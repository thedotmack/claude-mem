import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kimiAdapter } from '../../../src/cli/adapters/kimi.js';
import { devinAdapter } from '../../../src/cli/adapters/devin.js';
import { antigravityCliAdapter } from '../../../src/cli/adapters/antigravity-cli.js';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

test('Claude Code failures preserve the interrupted status and mark failed evidence', () => {
  const input = claudeCodeAdapter.normalizeInput({
    session_id: 'interrupted-write', cwd: process.cwd(), hook_event_name: 'PostToolUseFailure',
    tool_name: 'Write', tool_input: { file_path: 'cancelled.txt' }, error: 'User interrupted', is_interrupt: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(input.toolResponse)), {
    is_error: true, error: 'User interrupted', is_interrupt: true,
  });
});

test('Kimi PostToolUseFailure carries a worker-recognized failure marker', () => {
  const error = { code: 'tool_error', message: 'Permission denied', retryable: false };
  const input = kimiAdapter.normalizeInput({
    session_id: 'failed-read', cwd: process.cwd(), hook_event_name: 'PostToolUseFailure',
    tool_name: 'Read', tool_input: { path: 'denied.txt' }, error,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(input.toolResponse)), { is_error: true, error });
  assert.deepEqual(error, { code: 'tool_error', message: 'Permission denied', retryable: false });
});

test('Devin success:false preserves output and marks the failed edit', () => {
  const response = { success: false, output: '', error: 'File does not exist' };
  const input = devinAdapter.normalizeInput({
    session_id: 'failed-edit', cwd: process.cwd(), hook_event_name: 'PostToolUse',
    tool_name: 'edit', tool_input: { file_path: 'missing.txt' }, tool_response: response,
  });
  assert.equal(input.toolName, 'Edit');
  assert.deepEqual(JSON.parse(JSON.stringify(input.toolResponse)), { ...response, is_error: true });
  assert.equal(Object.hasOwn(response, 'is_error'), false);
});

test('Antigravity PostToolUse errors carry the same failure marker', () => {
  const input = antigravityCliAdapter.normalizeInput({
    conversationId: 'failed-write', workspacePaths: [process.cwd()],
    toolCall: { name: 'write_file', args: { file_path: 'denied.txt' } }, error: 'Permission denied',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(input.toolResponse)), { is_error: true, error: 'Permission denied' });
});

test('successful payloads retain their original output shape', () => {
  const base = { session_id: 'success', cwd: process.cwd(), hook_event_name: 'PostToolUse', tool_name: 'Read' };
  assert.equal(kimiAdapter.normalizeInput({ ...base, tool_output: 'file contents' }).toolResponse, 'file contents');
  const response = { success: true, output: 'saved', error: null };
  assert.equal(devinAdapter.normalizeInput({ ...base, tool_response: response }).toolResponse, response);
  assert.deepEqual(antigravityCliAdapter.normalizeInput({
    conversationId: 'success', workspacePaths: [process.cwd()],
    toolCall: { name: 'write_file', args: {} },
  }).toolResponse, { status: 'completed' });
});
