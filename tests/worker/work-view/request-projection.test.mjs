import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHumanRequests, humanRequestTitle, isHumanActionRequest, requestText } from '../../../src/services/work-view/request-projection.mjs';

const session = { id: 7, platform_source: 'codex', content_session_id: 'native-seven', user_prompt: 'Build a live tracker of my work.', started_at_epoch: 1 };
const prompts = [
  { id: 10, session_db_id: 7, prompt_number: 1, prompt_text: session.user_prompt, created_at_epoch: 1 },
  { id: 11, session_db_id: 7, prompt_number: 2, prompt_text: 'Keep the existing design.', created_at_epoch: 2 },
  { id: 12, session_db_id: 7, prompt_number: 3, prompt_text: 'Every row must represent a human request.', created_at_epoch: 3 },
];
const item = (id, extra = {}) => ({ id, title: `Implementation detail ${id}`, listId: 'work-list', listName: 'implementation-work', kind: 'work-state', project: 'repo/tree', lastUpdateEpoch: id, ...extra });
const agent = (id, items, sessionId = 7) => ({ id, label: 'Codex', sessionId, work: items });

test('one human conversation request owns two agents and multiple follow-up prompts', () => {
  const view = { agents: [agent('a', [item(1)]), agent('b', [item(2)])] };
  const result = buildHumanRequests(view, { sessions: [session], prompts });
  assert.equal(result.humanRequests.length, 1);
  const request = result.humanRequests[0];
  assert.equal(request.original.sourceId, 10);
  assert.equal(request.original.text, session.user_prompt);
  assert.deepEqual(request.agentIds, ['a', 'b']);
  assert.equal(request.items.length, 2);
  assert.equal(request.workstreams.length, 1);
  assert.deepEqual(request.scopeUpdates.map((update) => update.sourceId), [11, 12]);
  assert.equal(result.unlinkedWork.length, 0);
});

test('priming is skipped and a pasted human goal becomes the original request', () => {
  const primedSession = { ...session, user_prompt: 'Read KICKOFF.md and follow it.' };
  const goal = 'You are starting a project.\nGOAL: a visual skill editor that people can read and edit.';
  const result = buildHumanRequests({ agents: [agent('a', [item(1)])] }, { sessions: [primedSession], prompts: [
    { ...prompts[0], prompt_text: '<environment_context><cwd>/private/test</cwd></environment_context>' },
    { ...prompts[1], prompt_text: primedSession.user_prompt },
    { ...prompts[2], prompt_text: `<pasted_content>${goal}</pasted_content>` },
  ] });
  assert.equal(result.humanRequests.length, 1);
  assert.equal(result.humanRequests[0].original.sourceId, 12);
  assert.equal(humanRequestTitle(result.humanRequests[0].original), 'a visual skill editor that people can read and edit.');
  assert.equal(isHumanActionRequest(primedSession.user_prompt), false);
});

test('observation titles and task labels never become a top-level request without a human ask', () => {
  const result = buildHumanRequests({ agents: [agent('a', [item(1, { title: 'Build the whole requested product', kind: 'session-request' })])] }, {
    sessions: [{ ...session, user_prompt: 'Read AGENTS.md and follow it.' }], prompts: [],
  });
  assert.deepEqual(result.humanRequests, []);
  assert.equal(result.unlinkedWork.length, 1);
  assert.equal(result.unlinkedWork[0].reason, 'no-substantive-human-request');
});

test('independent conversations never merge because their prompt or work title matches', () => {
  const second = { ...session, id: 8, content_session_id: 'native-eight' };
  const result = buildHumanRequests({ agents: [agent('a', [item(1)]), agent('b', [item(2)], 8)] }, { sessions: [session, second], prompts });
  assert.equal(result.humanRequests.length, 2);
  assert.notEqual(result.humanRequests[0].id, result.humanRequests[1].id);
});

test('explicit request identity groups recorded work across conversations without using summaries', () => {
  const second = { ...session, id: 8, content_session_id: 'native-eight' };
  const result = buildHumanRequests({ agents: [
    agent('a', [item(1, { requestId: 'owner-request-77', requestText: 'Create the shared work tracker.' })]),
    agent('b', [item(2, { requestId: 'owner-request-77' })], 8),
  ] }, { sessions: [session, second], prompts, summaries: [{ request: 'Unrelated invented summary' }] });
  assert.equal(result.humanRequests.length, 1);
  assert.equal(result.humanRequests[0].explicitRequestId, 'owner-request-77');
  assert.equal(result.humanRequests[0].original.text, session.user_prompt);
  assert.equal(result.humanRequests[0].title, 'Create the shared work tracker.');
  assert.equal(result.humanRequests[0].conversationKeys.length, 2);
});

test('request and stream activity use matching sources or same-agent prompt observations only', () => {
  const work = item(1, { request: { key: 'prompt-one' }, sourceRefs: [{ kind: 'work-state', id: 1 }] });
  const actor = agent('a', [work]);
  actor.activity = [
    { id: 'work-state:1', kind: 'work-state', atEpoch: 1, requestKey: 'prompt-one' },
    { id: 'observation:2', kind: 'observation', atEpoch: 2, requestKey: 'prompt-one' },
    { id: 'observation:3', kind: 'observation', atEpoch: 3, requestKey: 'unrelated-prompt' },
    { id: 'work-state:4', kind: 'work-state', atEpoch: 4, requestKey: 'prompt-one' },
  ];
  const request = buildHumanRequests({ agents: [actor] }, { sessions: [session], prompts }).humanRequests[0];
  assert.deepEqual(request.activity.map((entry) => entry.id), ['observation:2', 'work-state:1']);
  assert.equal(request.activity[0].agentId, 'a');
  assert.equal(request.activity[0].requestKey, request.id);
  assert.equal(request.activity[0].promptRequestKey, 'prompt-one');
  assert.deepEqual(request.workstreams[0].activity, request.activity);
});

test('finished subtasks do not imply a finished human request without explicit lifecycle fields', () => {
  const records = { sessions: [session], prompts };
  let request = buildHumanRequests({ agents: [agent('a', [item(1, { status: 'done' })])] }, records).humanRequests[0];
  assert.equal(request.lifecycle, null);
  request = buildHumanRequests({ agents: [agent('a', [item(1, { status: 'done', requestComplete: true })])] }, records).humanRequests[0];
  assert.equal(request.lifecycle.explicit, true);
  assert.equal(request.lifecycle.status, 'done');
  assert.equal(request.lifecycle.field, 'request_complete');
});

test('an optional title cache changes display wording without changing request identity or original', () => {
  const view = { agents: [agent('a', [item(1)])] }, records = { sessions: [session], prompts };
  const before = buildHumanRequests(view, records).humanRequests[0];
  const after = buildHumanRequests(view, records, { titleCache: { [before.id]: 'Track live work' } }).humanRequests[0];
  assert.equal(after.id, before.id);
  assert.deepEqual(after.original, before.original);
  assert.equal(after.title, 'Track live work');
});

test('session initial human goal beats a truncated prompt slice containing only later steering', () => {
  const result = buildHumanRequests({ agents: [agent('a', [item(1)])] }, { sessions: [session], prompts: [prompts[2]] });
  assert.equal(result.humanRequests[0].original.source, 'session-initial-request');
  assert.equal(result.humanRequests[0].original.text, session.user_prompt);
});

test('attachment envelopes yield My request content instead of file metadata', () => {
  const wrapped = '# Files mentioned by the user:\n\n## image.png: /private/image.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\nmake this a looped video with video gen';
  assert.equal(requestText(wrapped), 'make this a looped video with video gen');
  assert.equal(humanRequestTitle(wrapped), 'make this a looped video with video gen');
  assert.equal(requestText('# Files mentioned by the user:\n## design.md: /private/design.md'), null);
});

test('quoted following title, Markdown links, and multiplication stay readable', () => {
  assert.equal(humanRequestTitle('write me a post for my blog called\n"Prompt Engineering for Assholes"\nuse this as our example'), 'write me a post for my blog called "Prompt Engineering for Assholes"');
  assert.equal(humanRequestTitle('Fix [multiplication](https://example.com/math) so 2*3 is 6'), 'Fix multiplication so 2*3 is 6');
});

test('vague assurances and testing permission do not override a later actionable request', () => {
  assert.equal(isHumanActionRequest('make sure this is working'), false);
  assert.equal(isHumanActionRequest('you can def do real tests, its all installed on this machine, you can test with codex and with claude code'), false);
  const records = { sessions: [{ ...session, user_prompt: 'make sure this is working' }], prompts: [
    { ...prompts[0], prompt_text: 'make sure this is working' },
    { ...prompts[1], prompt_text: 'yes fix the reactivate button' },
  ] };
  assert.equal(buildHumanRequests({ agents: [agent('a', [item(1)])] }, records).humanRequests[0].original.text, 'yes fix the reactivate button');
});

test('substantive requests in any language link work while priming and filler stay excluded', () => {
  for (const ask of ['Güncellemeyi doğrula', '3 yeni skilli anlat', 'Arregla el error de inicio de sesión', '修复登录错误', '로그인 버그를 고쳐줘', 'Исправь ошибку входа', 'the login page is broken']) {
    assert.equal(isHumanActionRequest(ask), true, ask);
  }
  for (const filler of ['hi', 'thanks!', 'continue', 'keep going', 'ok', '1', '?', 'Read AGENTS.md and follow it.', 'You are Codex, a coding agent.', '<environment_context><cwd>/private/test</cwd></environment_context>']) {
    assert.equal(isHumanActionRequest(filler), false, filler);
  }
  const result = buildHumanRequests({ agents: [agent('a', [item(1)])] }, { sessions: [{ ...session, user_prompt: 'Güncellemeyi doğrula' }], prompts: [
    { ...prompts[0], prompt_text: 'Güncellemeyi doğrula' },
  ] });
  assert.equal(result.unlinkedWork.length, 0);
  assert.equal(result.humanRequests[0].original.text, 'Güncellemeyi doğrula');
});

test('cached object titles require exact original source identity', () => {
  const view = { agents: [agent('a', [item(1)])] }, records = { sessions: [session], prompts };
  const original = buildHumanRequests(view, records).humanRequests[0];
  const cache = { [original.id]: { title: 'Track live work', sourceId: original.original.sourceId, source: original.original.source } };
  assert.equal(buildHumanRequests(view, records, { titleCache: cache }).humanRequests[0].title, 'Track live work');
  cache[original.id].sourceId = 999;
  assert.notEqual(buildHumanRequests(view, records, { titleCache: cache }).humanRequests[0].title, 'Track live work');
});
