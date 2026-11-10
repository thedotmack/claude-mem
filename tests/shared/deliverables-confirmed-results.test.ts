import { expect, it } from 'bun:test';
import { extractTranscriptFileActivityFromJsonl } from '../../src/shared/deliverables-transcript.js';

const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const call = (id: string, name = 'Write', input: unknown = { file_path: '/work/report.pdf' }) => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, isError = false) => user([{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'failed' : 'ok' }]);
const scan = (...lines: string[]) => extractTranscriptFileActivityFromJsonl([user('Prepare the report'), ...lines].join('\n'));

it('does not infer a deliverable from a write that never returned', () => {
  expect(scan(call('interrupted')).writes).toEqual([]);
});

it('does not attach files declared by an unfinished work-state write', () => {
  const activity = scan(call('pending', 'work_state_write', { list: 'report', fields: { work_product: '/work/report.pdf' } }));
  expect(activity.workStateWrites).toEqual([]);
});

it('keeps the last completed revision when a later write to the same path is interrupted', () => {
  const activity = scan(call('completed'), result('completed'), call('interrupted', 'Edit'));
  expect(activity.writes.map(write => write.toolUseId)).toEqual(['completed']);
});

it('cannot reuse an earlier result for a later invocation with the same id', () => {
  expect(scan(result('orphan'), call('orphan')).writes).toEqual([]);
  const activity = scan(call('reused'), result('reused'), call('reused', 'Edit', { file_path: '/work/new.pdf' }));
  expect(activity.writes.map(write => write.path)).toEqual(['/work/report.pdf']);
});

it('keeps successful writes and declarations while excluding explicit failures', () => {
  const activity = scan(
    call('ok'), result('ok'),
    call('failed', 'Write', { file_path: '/work/failed.pdf' }), result('failed', true),
    call('declared', 'work_state_write', { list: 'report', fields: { work_product: '/work/report.pdf' } }), result('declared'),
  );
  expect(activity.writes.map(write => write.toolUseId)).toEqual(['ok']);
  expect(activity.workStateWrites.map(write => write.toolUseId)).toEqual(['declared']);
});
