import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildSharedProjectionUpdates } from '../../../src/services/work-view/shared-projection.mjs';
import { conversationKey } from '../../../src/services/work-view/request-projection.mjs';

const databases: Database[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
const database = () => {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
};
const session = (id: number, platform = 'claude', content = `conversation-${id}`) => ({
  id, platform_source: platform, content_session_id: content, memory_session_id: `memory-${id}`,
  project: 'repo', user_prompt: `Request ${id}`,
});

test('publishing many sessions does not re-read the whole tool-call batch per session', () => {
  const sessions = Array.from({ length: 100 }, (_, index) => session(index + 1));
  let sessionReads = 0;
  const calls = Array.from({ length: 1000 }, (_, index) => ({
    id: index + 1,
    get session_db_id() { sessionReads++; return index % sessions.length + 1; },
  }));
  const updates = buildSharedProjectionUpdates(database(), { deviceId: 'local', records: { sessions, calls } });
  expect(updates.map(update => update.key)).toEqual(sessions.map(conversationKey));
  // A linear access budget, independent of the number of receiving sessions.
  expect(sessionReads).toBeLessThanOrEqual(calls.length * 3);
});

test('keeps product order, platform scope and the first deliverable-only session', () => {
  const claude = session(1, 'claude', 'same-native-id');
  const codex = session(2, 'codex', 'same-native-id');
  const absent = session(3);
  const copied = { ...session(4), user_prompt: 'First copied conversation' };
  const calls = [{ id: 10, session_db_id: claude.id }];
  const productCalls = [1, 2].map(id => ({
    id, session_db_id: codex.id, tool_name: 'Artifact', tool_input: '{}',
    tool_response: JSON.stringify({ url: `https://example.com/codex-${id}` }), created_at_epoch: 100,
  }));
  const agentLaunches = [codex, claude, codex].map((owner, index) => ({
    ...owner, agent_id: `agent-${index}`, description: `${owner.platform_source} launch`,
  }));
  const agentToolActivity = agentLaunches.map(row => ({ ...row, last_epoch: 100 }));
  const records = {
    sessions: [codex, absent, claude], calls, productCalls, agentLaunches, agentToolActivity,
    productDeliverables: [copied, { ...copied, user_prompt: 'Later copied conversation' }],
  };
  const updates = buildSharedProjectionUpdates(database(), { deviceId: 'local', records, view: {
    agents: [{ work: [{ attribution: { sessionId: claude.id }, workProduct: [
      { kind: 'artifact', title: 'Claude result', url: 'https://example.com/claude', atEpoch: 100 },
    ] }] }],
  } });
  expect(updates.map(update => update.key)).toEqual([codex, claude, copied].map(conversationKey));
  expect(updates[0].value.products.map((product: any) => product.url)).toEqual([
    'https://example.com/codex-1', 'https://example.com/codex-2',
  ]);
  expect(updates[1].value.products.map((product: any) => product.url)).toEqual(['https://example.com/claude']);
  expect(updates[0].value.launches.map((launch: any) => launch.agent_id)).toEqual(['agent-0', 'agent-2']);
  expect(updates[1].value.activity.map((activity: any) => activity.agent_id)).toEqual(['agent-1']);
  expect(updates[2].value.session.user_prompt).toBe('First copied conversation');
  expect(records.sessions).toEqual([codex, absent, claude]);
});
