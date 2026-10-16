import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { toRecorderParts } from '../../src/services/wire-gateway/ir/recorder-parts.js';
import { emptyWireUsage, type WireRequest } from '../../src/services/wire-gateway/ir/types.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import { agentIdFromUserAgent, resolveAgentId } from '../../src/services/wire-gateway/identity/agent-of.js';
import { WireLaunchRegistry, LAUNCH_ID_PATTERN, splitLaunchSegment } from '../../src/services/wire-gateway/identity/launch-registry.js';
import { resolveIdentity, sessionIdToEcho, sessionWasNamedByClient, type WireIdentity } from '../../src/services/wire-gateway/identity/resolve-identity.js';
import { cleanSessionId, fingerprintSessionId, MAX_SESSION_ID_BYTES } from '../../src/services/wire-gateway/identity/session-id.js';
import { SESSION_STALE_MS, TURN_QUIET_MS, TurnTracker, type WireSessionStale, type WireTurnEnd } from '../../src/services/wire-gateway/identity/turn-tracker.js';
import { userTurnPositionOfRequest } from '../../src/services/wire-gateway/identity/turn-start.js';
import { firstUserWordsOfConversation, userWordsInText } from '../../src/services/wire-gateway/identity/user-words.js';
import { gitRepositoryOnDisk, gitRepositorySaidInText, workDirSaidInText, workPlaceOfRequest } from '../../src/services/wire-gateway/identity/work-dir.js';

// Phase 4: identity. Literal bodies and texts are magpie's (MIT, Copyright (c)
// 2026 yetone, e297a8ab2) unless said otherwise; test names cite the source.

const MAGPIE_FIXTURES = join(import.meta.dir, '../fixtures/wire-gateway/magpie');
const encoder = new TextEncoder();

function parseFixture(relativePath: string, protocol: WireProtocol): WireRequest {
  return parseWireRequest(protocol, new Uint8Array(readFileSync(join(MAGPIE_FIXTURES, relativePath))));
}

function parseBody(protocol: WireProtocol, body: string, suffixPath?: string): WireRequest {
  return parseWireRequest(protocol, encoder.encode(body), { suffixPath });
}

function identityOf(
  options: { agentId?: string; headers?: Record<string, string>; request?: WireRequest | null; suffixPath?: string; launch?: ReturnType<WireLaunchRegistry['create']> } = {},
): WireIdentity {
  return resolveIdentity(
    { agentId: options.agentId ?? 'claude-code' },
    new Headers(options.headers ?? {}),
    options.request ?? null,
    { suffixPath: options.suffixPath ?? '/v1/messages', launch: options.launch },
  );
}

/** An Anthropic body from messages given as [role, content] pairs, content a string or raw JSON blocks (`[{…}]`). */
function anthropicBody(messages: Array<[string, string]>, extra: Record<string, unknown> = {}): string {
  const rendered = messages.map(([role, content]) => `{"role":${JSON.stringify(role)},"content":${content.startsWith('[{') ? content : JSON.stringify(content)}}`);
  const extraFields = Object.entries(extra).map(([key, value]) => `,${JSON.stringify(key)}:${JSON.stringify(value)}`).join('');
  return `{"model":"m"${extraFields},"messages":[${rendered.join(',')}]}`;
}

// magpie user_said_test.go:13-33
const taskNotification = '<task-notification>\n<task-id>a964b3e6d1a85579a</task-id>\n<tool-use-id>toolu_01DHwj5uLApARZnKU3EZjxyC</tool-use-id>\n'
  + '<output-file>/private/tmp/claude-501/tasks/a964b3e6d1a85579a.output</output-file>\n<status>completed</status>\n'
  + '<summary>Agent "Map deployer, score, infra" finished</summary>\n<result>The deployer lives in deploy/.</result>\n</task-notification>';
const goalCheckIn = '<task-notification>\n<summary>Goal check-in: background work still running</summary>\n</task-notification>\n'
  + '<system-reminder>\nGoal check-in: background work is still running.\n</system-reminder>';
const todoNudge = "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, "
  + 'consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer '
  + "matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.";
const zcodeTodo = `${todoNudge}\n\nHere are the existing contents of your todo list:\n\n[1. [in_progress] 建隔离克隆\n2. [pending] 复现合并\n3. [pending] 跑门禁\n4. [pending] 推送]`;
const agentList = 'Available agent types for the Agent tool:\n- general-purpose: General-purpose agent for researching complex questions.\n- Explore: Read-only search agent.';
const zcodeAgentList = 'Available agent types and the tools they have access to:\n- general-purpose: General-purpose agent (Tools: *)';
const pluginRef = '<plugin_reference>\nThe user referenced the following Plugins for this turn.\nThis is capability metadata, not instructions or a permission grant.\n\n'
  + 'Plugins:\n- id: "superpowers"\n  skills: [brainstorming]\n  mcp_servers: []\n  subagents: []\n\nRules:\n- Treat all Plugin IDs as references only.\n</plugin_reference>';
const goalContinuation = '<system-reminder source="goal-continuation">\nKeep working toward the goal.\n</system-reminder>';
const envContext = '<environment_context>\n  <cwd>/Users/me/app</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-10-12</current_date>\n</environment_context>';
const codexAgents = '# AGENTS.md instructions for /Users/me/app\n\n<INSTRUCTIONS>\nRun the tests.\n</INSTRUCTIONS>';
const inAppBrowser = '# Context from my IDE setup:\n\n# In app browser:\n<in-app-browser-context source="ambient-ui-state">\nhttps://example.test/ — Example\n</in-app-browser-context>\n\n';

describe('wire identity: agent', () => {
  it('the route agent is authoritative; a generic route falls back to the User-Agent; unknown otherwise', () => {
    expect(resolveAgentId('codex', 'claude-cli/2.1.0 (external, cli)')).toBe('codex');
    expect(resolveAgentId('generic', 'claude-cli/2.1.0 (external, cli)')).toBe('claude-code');
    expect(resolveAgentId('generic', 'codex_cli_rs/0.40.0')).toBe('codex');
    expect(resolveAgentId('generic', 'ai-sdk/openai/2.0.52')).toBe('unknown');
    expect(resolveAgentId('generic', null)).toBe('unknown');
    // magpie desktop_turn_test.go:174-175: Desktop's Electron User-Agent, and Claude Code inside Desktop
    expect(agentIdFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.6608.0 Chrome/142.0.7444.235 Electron/39.2.7 Safari/537.36')).toBe('claude-desktop');
    expect(agentIdFromUserAgent('claude-cli/2.1.295 (external, claude-desktop)')).toBe('claude-code');
    expect(agentIdFromUserAgent('pi-coding-agent/1.1.0')).toBe('pi');
    expect(agentIdFromUserAgent('GeminiCLI/0.9.0 (darwin; arm64)')).toBe('gemini-cli');
  });
});

describe('wire identity: session precedence and caps', () => {
  it('x-claude-mem-session > launch > agent headers in list order > body > fingerprint', () => {
    const request = parseFixture('workdir/claude-code-2.1.296.json', 'anthropic');
    const launch = new WireLaunchRegistry().create({ agentId: 'claude-code', cwd: '/Users/me/launched' });
    const allHeaders = {
      'x-claude-mem-session': ' mine ',
      'x-claude-code-session-id': 'cc-1',
      'x-opencode-session': 'oc-1',
      'x-session-affinity': 'aff-1',
      'x-session-id': 'xs-1',
      session_id: 'us-1',
      'session-id': 'ds-1',
      'thread-id': 'th-1',
    };
    expect(identityOf({ headers: allHeaders, request, launch })).toMatchObject({ sessionId: 'mine', sessionSource: 'named' });
    const { 'x-claude-mem-session': _named, ...agentHeaders } = allHeaders;
    expect(identityOf({ headers: agentHeaders, request, launch })).toMatchObject({ sessionId: launch.launchId, sessionSource: 'launch', workDir: '/Users/me/launched' });
    const order = ['x-claude-code-session-id', 'x-opencode-session', 'x-session-affinity', 'x-session-id', 'session_id', 'session-id', 'thread-id'];
    for (let index = 0; index < order.length; index++) {
      const headers = Object.fromEntries(order.slice(index).map(name => [name, agentHeaders[name as keyof typeof agentHeaders]]));
      expect(identityOf({ headers, request })).toMatchObject({ sessionId: headers[order[index]], sessionSource: 'header' });
    }
    expect(identityOf({ request })).toMatchObject({ sessionId: '790b2fef-7571-49e7-8619-e5bf3806b7ca', sessionSource: 'body' });
    expect(identityOf({ request: parseBody('anthropic', anthropicBody([['user', 'hi']])) }).sessionSource).toBe('fingerprint');
  });

  it('trims, refuses control characters (falling through to the next source) and caps at 128 bytes on a UTF-8 boundary', () => {
    expect(cleanSessionId('  abc  ')).toBe('abc');
    expect(cleanSessionId('   ')).toBeUndefined();
    expect(cleanSessionId('a\u0001b')).toBeUndefined();
    expect(cleanSessionId('a\tb')).toBeUndefined();
    expect(cleanSessionId('x'.repeat(300))).toBe('x'.repeat(MAX_SESSION_ID_BYTES));
    const multiByte = cleanSessionId('é'.repeat(100))!; // 2 bytes each
    expect(new TextEncoder().encode(multiByte).length).toBe(128);
    const threeByte = cleanSessionId('中'.repeat(50))!; // 3 bytes each: 42 fit
    expect(threeByte).toBe('中'.repeat(42));
    expect(identityOf({ headers: { 'x-claude-mem-session': 'bad\tid', 'x-session-id': 'good' } })).toMatchObject({ sessionId: 'good', sessionSource: 'header' });
  });

  it('echoes only sessions the client named (sources 1-4)', () => {
    expect(['named', 'launch', 'header', 'body'].every(source => sessionWasNamedByClient(source as WireIdentity['sessionSource']))).toBe(true);
    expect(sessionWasNamedByClient('fingerprint')).toBe(false);
    expect(sessionIdToEcho({ sessionId: 'café-1', sessionSource: 'header' })).toBe('café-1');
    expect(sessionIdToEcho({ sessionId: '会话-1', sessionSource: 'body' })).toBeUndefined();
    expect(sessionIdToEcho({ sessionId: 'wire-abc', sessionSource: 'fingerprint' })).toBeUndefined();
  });
});

describe('wire identity: body ids from captured fixtures', () => {
  it('Claude Code 2.1.296 metadata.user_id (a JSON string) → session_id', () => {
    const identity = identityOf({ request: parseFixture('workdir/claude-code-2.1.296.json', 'anthropic') });
    expect(identity).toMatchObject({ sessionId: '790b2fef-7571-49e7-8619-e5bf3806b7ca', sessionSource: 'body', kind: 'turn' });
  });

  it('Codex 0.162.0 client_metadata.thread_id, with its turn_id as the native prompt id', () => {
    const identity = identityOf({ agentId: 'codex', suffixPath: '/v1/responses', request: parseFixture('workdir/codex-0.162.0.json', 'openai-responses') });
    expect(identity).toMatchObject({
      sessionId: '01a1284b-bf01-7cb0-9ee6-e83df5756127',
      sessionSource: 'body',
      kind: 'turn',
      nativePromptId: '01a1284b-c30f-73e1-b316-0f863b32284b',
    });
  });

  it('Codex 0.162.1 has no flat thread id: the JSON string client_metadata["x-codex-turn-metadata"] names it', () => {
    const identity = identityOf({ agentId: 'codex', suffixPath: '/v1/responses', request: parseFixture('workdir/codex-0.162.1-tool-search.json', 'openai-responses') });
    expect(identity).toMatchObject({ sessionId: '01a13158-1ced-7c30-8ae8-dcb0d96f0fc2', sessionSource: 'body', nativePromptId: '01a13158-1d17-7933-8a97-8e8a803a7b45' });
  });

  it('OpenCode 2.0.25 prompt_cache_key starting ses_', () => {
    const identity = identityOf({ agentId: 'opencode', suffixPath: '/v1/responses', request: parseFixture('opencode2_responses_tools.json', 'openai-responses') });
    expect(identity).toMatchObject({ sessionId: 'ses_ecb73ba1dffeYzbeZjtsJjXr6r', sessionSource: 'body' });
    // A cache key that is not OpenCode's session is no session.
    const keyed = parseBody('openai-chat', '{"model":"m","prompt_cache_key":"abc","messages":[{"role":"user","content":"hi"}]}');
    expect(identityOf({ agentId: 'opencode', request: keyed, suffixPath: '/v1/chat/completions' }).sessionSource).toBe('fingerprint');
  });

  it('Pi 1.1.0 names nothing: its session is a fingerprint', () => {
    const identity = identityOf({ agentId: 'pi', suffixPath: '/v1/chat/completions', request: parseFixture('workdir/pi-1.1.0.json', 'openai-chat') });
    expect(identity.sessionSource).toBe('fingerprint');
    expect(identity.sessionId).toMatch(/^wire-[0-9a-f]{24}$/);
  });
});

describe('wire identity: fingerprint', () => {
  // magpie user_said_test.go:121-140 (TestFirstWordsAreWhatTheUserSaid)
  const first = '合并远程分支，推到 master';
  const asRequest = (messages: Array<[string, string]>) => parseBody('anthropic', anthropicBody(messages));
  const fingerprintOf = (messages: Array<[string, string]>, agentId = 'claude-code') => identityOf({ agentId, request: asRequest(messages) }).sessionId;

  it('stays the same when an instruction file, reminder, plugin metadata or Codex context changes', () => {
    const blocks = (...texts: string[]) => JSON.stringify(texts.map(text => ({ type: 'text', text })));
    const original = fingerprintOf([['user', blocks('<system-reminder>\nContents of /a/CLAUDE.md (project instructions):\nv1\n</system-reminder>', first)]]);
    expect(original).toBe(fingerprintSessionId('claude-code', first));
    for (const messages of [
      [['user', blocks('<system-reminder>\nContents of /a/CLAUDE.md (project instructions):\nv2, edited\n</system-reminder>', first)], ['assistant', 'done'], ['user', 'more']],
      [['user', blocks(first, pluginRef)], ['user', agentList]],
      [['user', goalContinuation], ['assistant', 'done'], ['user', first]],
      [['user', blocks(codexAgents, envContext, first)]],
    ] as Array<Array<[string, string]>>) {
      expect(fingerprintOf(messages)).toBe(original);
    }
  });

  it('differs for other words, for another agent, and between conversations with no words yet', () => {
    const original = fingerprintOf([['user', first]]);
    expect(fingerprintOf([['user', 'map the deployer']])).not.toBe(original);
    expect(fingerprintOf([['user', first]], 'codex')).not.toBe(original);
    expect(fingerprintOf([['user', envContext]])).not.toBe(fingerprintOf([['user', agentList]]));
    expect(firstUserWordsOfConversation(asRequest([['user', envContext]]))).toBe(envContext);
  });
});

describe('wire identity: subagents and lineage', () => {
  it('Claude Code: agent id plus parent only with an agent id; the session stays the parent\'s (magpie usage_api_test.go:46-75)', () => {
    const request = parseBody('anthropic', anthropicBody([['user', 'go']]), '/v1/messages');
    const nested = identityOf({
      request,
      headers: { 'x-claude-code-session-id': 'conv-1', 'x-claude-code-agent-id': 'a143287ac46b82a96', 'x-claude-code-parent-agent-id': 'a99ca20c03d1813d8' },
    });
    expect(nested).toMatchObject({ sessionId: 'conv-1', subagent: 'a143287ac46b82a96', parentSubagent: 'a99ca20c03d1813d8', kind: 'subagent' });
    const parentOnly = identityOf({ request, headers: { 'x-claude-code-session-id': 'conv-1', 'x-claude-code-parent-agent-id': 'a99ca20c03d1813d8' } });
    expect(parentOnly.subagent).toBeUndefined();
    expect(parentOnly.parentSubagent).toBeUndefined();
    expect(parentOnly.kind).toBe('turn');
  });

  it('Codex: a spawned agent by x-openai-subagent or thread_source, named by agent_name, with its parent thread', () => {
    const body = (turnMetadata: Record<string, unknown>) => parseBody('openai-responses',
      `{"model":"m","input":[{"role":"user","content":"research"}],"client_metadata":{"x-codex-turn-metadata":${JSON.stringify(JSON.stringify(turnMetadata))}}}`);
    const spawned = identityOf({
      agentId: 'codex', suffixPath: '/v1/responses',
      headers: { 'x-openai-subagent': 'collab_spawn', 'x-codex-parent-thread-id': 'parent-thread' },
      request: body({ thread_id: 'child-thread', agent_name: '/root/research', thread_source: 'subagent', turn_id: 't1' }),
    });
    expect(spawned).toMatchObject({ kind: 'subagent', subagent: '/root/research', sessionId: 'child-thread', parentSessionId: 'parent-thread' });
    const bySource = identityOf({
      agentId: 'codex', suffixPath: '/v1/responses',
      request: body({ thread_id: 'child-2', thread_source: 'subagent', parent_thread_id: 'root-thread', agent_name: '/root/worker' }),
    });
    expect(bySource).toMatchObject({ kind: 'subagent', subagent: '/root/worker', parentSessionId: 'root-thread' });
  });

  it('Codex agent_message keeps its author and recipient in the IR', () => {
    const request = parseBody('openai-responses', '{"model":"m","input":[{"type":"agent_message","author":"/root/research","recipient":"/root","content":[{"type":"input_text","text":"found it"}]}]}');
    expect(request.messages[0].parts[0]).toMatchObject({ author: '/root/research', recipient: '/root', text: 'found it' });
  });
});

describe('wire identity: request kind', () => {
  const claudeCodeTurn = '{"model":"claude-opus-5-5","max_tokens":64000,"stream":true,"tools":[{"name":"Bash","input_schema":{"type":"object"}}],"messages":[{"role":"user","content":"hi"}]}';
  const kindOf = (body: string, options: { agentId?: string; headers?: Record<string, string>; suffixPath?: string; protocol?: WireProtocol } = {}) =>
    identityOf({ agentId: options.agentId, headers: options.headers, suffixPath: options.suffixPath, request: parseBody(options.protocol ?? 'anthropic', body, options.suffixPath) }).kind;

  it('Claude Code\'s request-class hint wins when present', () => {
    expect(kindOf(claudeCodeTurn, { headers: { 'x-claude-code-request-class': 'auxiliary' } })).toBe('helper:auxiliary');
    expect(kindOf(claudeCodeTurn, { headers: { 'x-claude-code-request-class': 'compaction' } })).toBe('compaction');
    expect(kindOf(claudeCodeTurn, { headers: { 'x-claude-code-request-class': 'subagent' } })).toBe('subagent');
    expect(kindOf(claudeCodeTurn, { headers: { 'x-claude-code-request-class': 'workflow' } })).toBe('subagent');
    // A main hint overrides a detector that would say helper.
    const title = '{"model":"m","max_tokens":200,"system":"You write short session titles. Reply with only the tagged fields the prompt asks for.","messages":[{"role":"user","content":"hi"}]}';
    expect(kindOf(title, { headers: { 'x-claude-code-request-class': 'main' } })).toBe('turn');
    expect(kindOf(claudeCodeTurn)).toBe('turn');
  });

  it('count_tokens and Responses compact paths', () => {
    expect(identityOf({ suffixPath: '/v1/messages/count_tokens' }).kind).toBe('helper:count_tokens');
    expect(identityOf({ agentId: 'codex', suffixPath: '/v1/responses/compact' }).kind).toBe('compaction');
  });

  it('auto-mode classifier (magpie automode_test.go:30-37)', () => {
    const autoModeAsk = `{"model":"claude-sonnet-5","max_tokens":64,"temperature":1,"stream":true,
      "system":[{"type":"text","text":"You are a security monitor for an autonomous coding agent.\\n## Output Format\\nAnswer <block>yes</block><category>…</category><reason>…</reason> to block the action, else <block>no</block>."}],
      "thinking":{"type":"disabled"},
      "stop_sequences":["</block>"],
      "messages":[
        {"role":"user","content":[{"type":"text","text":"The user's settings allow reading and editing files in the project."}]},
        {"role":"user","content":[{"type":"text","text":"<transcript>\\n"},{"type":"text","text":"User: tidy up the build\\nAction: Bash rm -rf build/\\n"},{"type":"text","text":"</transcript>\\n"}]}]}`;
    // Seen by its own detector even from an agent the small rule does not cover.
    expect(kindOf(autoModeAsk, { agentId: 'opencode' })).toBe('helper:auto_mode_classifier');
  });

  it('title helpers: Desktop\'s title prompt, and Claude\'s small tool-less side calls (magpie desktop_turn_test.go:189-210)', () => {
    const notificationClassifier = '{"model":"claude-sonnet-5","max_tokens":1024,"stream":true,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.296.523; cc_entrypoint=claude-desktop;"},{"type":"text","text":"A user kicked off a Claude Code agent to do a coding task and walked away."}],"messages":[{"role":"user","content":"…"}]}';
    const securityMonitor = '{"model":"claude-sonnet-5","max_tokens":64,"stream":true,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.295; cc_entrypoint=claude-desktop;"},{"type":"text","text":"You are a security monitor for autonomous AI coding agents."}],"messages":[{"role":"user","content":"<transcript>…</transcript>"}]}';
    const securityMonitorThinking = '{"model":"claude-sonnet-5","max_tokens":2304,"thinking":{"type":"enabled","budget_tokens":2048},"stream":true,"system":[{"type":"text","text":"You are a security monitor for autonomous AI coding agents."}],"messages":[{"role":"user","content":"<transcript>…</transcript>"}]}';
    const desktopTitle = '{"model":"claude-sonnet-5","max_tokens":200,"stream":true,"system":"You write short session titles. Reply with only the tagged fields the prompt asks for.","messages":[{"role":"user","content":"hi"}]}';
    const cliTitle = '{"model":"claude-sonnet-5","messages":[{"role":"user","content":[{"type":"text","text":"fix the mobile login button","cache_control":{"type":"ephemeral"}}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.296.3fd; cc_entrypoint=claude-desktop;"},{"type":"text","text":"You are a Claude agent, built on Anthropic\'s Claude Agent SDK.","cache_control":{"type":"ephemeral"}},{"type":"text","text":"You write short session titles. Reply with only the tagged fields the prompt asks for.","cache_control":{"type":"ephemeral"}}],"tools":[],"max_tokens":64000,"stream":true}';
    for (const body of [notificationClassifier, securityMonitor, securityMonitorThinking, desktopTitle, cliTitle]) {
      expect(kindOf(body)).toBe('helper:title');
    }
    expect(kindOf(desktopTitle, { agentId: 'claude-desktop' })).toBe('helper:title');
    // Only the title prompt itself counts for other agents; their small tool-less calls stay turns.
    expect(kindOf(notificationClassifier, { agentId: 'opencode' })).toBe('turn');
    expect(kindOf(desktopTitle, { agentId: 'opencode' })).toBe('helper:title');
    // A small request that offers tools is a turn.
    expect(kindOf('{"model":"m","max_tokens":100,"tools":[{"name":"Bash","input_schema":{}}],"messages":[{"role":"user","content":"hi"}]}')).toBe('turn');
  });

  it('prompt suggestions: the [SUGGESTION MODE: literal (magpie claude_side_question_test.go:45)', () => {
    const suggestionMode = "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nFIRST: Look at the user's recent messages and original request.\n\nReply with ONLY the suggestion, no quotes or explanation.";
    const body = anthropicBody([['user', 'fix it'], ['assistant', 'done'], ['user', suggestionMode]], { max_tokens: 64000, tools: [{ name: 'Bash', input_schema: {} }] });
    expect(kindOf(body)).toBe('helper:suggestion');
  });

  it('Codex side kinds by header and thread source, through magpie\'s alias table', () => {
    const codexBody = '{"model":"m","input":[{"role":"user","content":"fix it"}]}';
    const codexKind = (headers: Record<string, string>) => kindOf(codexBody, { agentId: 'codex', headers, suffixPath: '/v1/responses', protocol: 'openai-responses' });
    expect(codexKind({ 'x-openai-subagent': 'thread_title' })).toBe('helper:thread_title');
    expect(codexKind({ 'x-openai-subagent': 'title_generation' })).toBe('helper:thread_title');
    expect(codexKind({ 'x-openai-subagent': 'thread_description' })).toBe('helper:thread_description');
    expect(codexKind({ 'x-openai-subagent': 'composer_predictions' })).toBe('helper:composer_predictions');
    expect(codexKind({ 'x-openai-subagent': 'memory_consolidation' })).toBe('helper:memory_consolidation');
    expect(codexKind({ 'x-openai-memgen-request': '1' })).toBe('helper:memory_consolidation');
    expect(codexKind({ 'x-openai-subagent': 'guardian_review' })).toBe('helper:guardian');
    expect(codexKind({ 'x-openai-subagent': 'review' })).toBe('helper:review');
    expect(codexKind({ 'x-openai-subagent': 'compact' })).toBe('compaction');
    expect(codexKind({ 'x-openai-subagent': 'collab_spawn' })).toBe('subagent');
    expect(codexKind({ 'x-codex-turn-metadata': '{"thread_source":"thread_title"}' })).toBe('helper:thread_title');
    expect(codexKind({ 'x-codex-turn-metadata': '{"thread_source":"user"}' })).toBe('turn');
    expect(codexKind({})).toBe('turn');
  });

  it('compaction: each agent\'s prompt, Codex\'s compaction_trigger and Claude Code\'s header (magpie compacting_test.go:15-45)', () => {
    const codexCompactPrompt = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.';
    const compacting: Array<[string, string, WireProtocol]> = [
      ['claude code', anthropicBody([['user', 'fix it'], ['assistant', 'done'], ['user', "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests"]], { system: "You are Claude Code, Anthropic's official CLI for Claude.\nYou are a helpful AI assistant tasked with summarizing conversations." }), 'anthropic'],
      ['codex', anthropicBody([['user', 'fix it'], ['assistant', 'done'], ['user', codexCompactPrompt]]), 'anthropic'],
      ['opencode', anthropicBody([['user', 'fix it']], { system: 'You are a context summarization agent. You are given a conversation between a user and an agent.' }), 'anthropic'],
      ['pi', anthropicBody([['user', '<conversation>…</conversation>']], { system: 'You are a context summarization assistant. Your task is to read a conversation' }), 'anthropic'],
      ['gemini cli', anthropicBody([['user', 'fix it']], { system: 'You are a specialized system component responsible for distilling chat history into a structured XML <state_snapshot>.' }), 'anthropic'],
      ['qwen code', anthropicBody([['user', 'fix it']], { system: 'You are the component that summarizes a conversation when its context window is about to overflow. The summary' }), 'anthropic'],
      ['kimi', anthropicBody([['user', 'fix it'], ['assistant', 'done'], ['user', '---\n\nThe above is a list of messages in an agent conversation. You are now given a task to compact this conversation context according to specific priorities and rules.']]), 'anthropic'],
      ['codex trigger', '{"model":"m","input":[{"role":"user","content":"fix it"},{"role":"assistant","content":"done"},{"type":"compaction_trigger"}]}', 'openai-responses'],
    ];
    for (const [name, body, protocol] of compacting) {
      expect(kindOf(body, { protocol, agentId: 'opencode' }), name).toBe('compaction');
    }
    for (const [name, body] of [
      ['plain', anthropicBody([['user', 'fix it']], { system: 'You are a coding agent.' })],
      ['quoted', anthropicBody([['user', codexCompactPrompt], ['assistant', 'done'], ['user', 'thanks, go on']])],
      ['far in', anthropicBody([['user', 'fix it']], { system: `${'x'.repeat(3000)}You are a context summarization agent.` })],
    ]) {
      expect(kindOf(body, { agentId: 'opencode' }), name).toBe('turn');
    }
    expect(kindOf(claudeCodeTurn, { headers: { 'x-claude-code-compaction': '1' } })).toBe('compaction');
  });
});

describe('wire identity: folder', () => {
  it('each agent\'s own fixture (magpie workdir_test.go:29-47)', () => {
    expect(workPlaceOfRequest(parseFixture('workdir/claude-code-2.1.296.json', 'anthropic'))).toEqual({ workDir: '/Users/me/work/proj/a&b <c> 中文', gitRepositorySaid: false });
    expect(workPlaceOfRequest(parseFixture('workdir/codex-0.162.0.json', 'openai-responses')).workDir).toBe('/Users/me/work/proj/a&b <c> 中文');
    expect(workPlaceOfRequest(parseFixture('workdir/pi-1.1.0.json', 'openai-chat')).workDir).toBe('/Users/me/work/proj/My Proj');
  });

  it('OpenCode\'s <env>, in the system prompt and after a change (magpie workdir_test.go:52-67)', () => {
    const env = (dir: string) => ['<env>', `  Working directory: ${dir}`, '  Workspace root folder: /Users/me', '  Is directory a git repo: yes', '  Platform: darwin', '</env>'].join('\n');
    const system = `You are opencode.\nHere is some useful information about the environment you are running in:\n${env('/Users/me/acme')}`;
    const first = parseBody('openai-chat', JSON.stringify({ model: 'm', messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }] }));
    expect(workPlaceOfRequest(first)).toEqual({ workDir: '/Users/me/acme', gitRepositorySaid: true });
    const moved = parseBody('openai-chat', JSON.stringify({ model: 'm', messages: [
      { role: 'system', content: system }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' },
      { role: 'user', content: `The environment you are running in is now:\n${env('/Users/me/oss')}` },
    ] }));
    expect(workPlaceOfRequest(moved).workDir).toBe('/Users/me/oss');
  });

  it('the last said wins; model and tool text are ignored; nothing said is undefined, never "" (magpie workdir_test.go:73-90)', () => {
    const fixture = JSON.parse(readFileSync(join(MAGPIE_FIXTURES, 'workdir/claude-code-2.1.296.json'), 'utf-8'));
    fixture.messages.push(
      { role: 'assistant', content: [{ type: 'text', text: ' - Primary working directory: /from/the/model' }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: '<cwd>/from/a/tool</cwd>' },
        { type: 'text', text: '<system-reminder>\nPrimary working directory: /Users/me/next (was /Users/me/work/proj/a&b &lt;c&gt; 中文)\n</system-reminder>' },
      ] },
    );
    expect(workPlaceOfRequest(parseBody('anthropic', JSON.stringify(fixture))).workDir).toBe('/Users/me/next');
    // Only the model or a tool said it: unknown.
    const onlyModelAndTool = parseBody('anthropic', anthropicBody([
      ['user', 'go'],
      ['assistant', ' - Primary working directory: /from/the/model'],
      ['user', '[{"type":"tool_result","tool_use_id":"t1","content":"<cwd>/from/a/tool</cwd>"}]'],
    ]));
    expect(workPlaceOfRequest(onlyModelAndTool)).toEqual({});
    for (const text of ['hi', 'Working directory: /x', 'the <cwd></cwd> tag']) {
      const request = parseBody('anthropic', anthropicBody([['user', text]], { system: 'You are an agent.' }));
      expect(workPlaceOfRequest(request).workDir, text).toBeUndefined();
      expect(identityOf({ request }).workDir, text).toBeUndefined();
      expect('workDir' in identityOf({ request })).toBe(false);
    }
  });

  it('git: what the agent says wins; otherwise the disk answers only for an absolute folder that exists here', () => {
    mkdirSync(WIRE_GATEWAY_DIR, { recursive: true });
    const scratch = mkdtempSync(join(WIRE_GATEWAY_DIR, 'identity-git-'));
    try {
      const repo = join(scratch, 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, 'pkg', 'deep'), { recursive: true });
      expect(gitRepositoryOnDisk(join(repo, 'pkg', 'deep'))).toBe(true);
      expect(gitRepositoryOnDisk(join(scratch, 'missing'))).toBeUndefined();
      expect(gitRepositoryOnDisk('relative/path')).toBeUndefined();
      const said = parseBody('anthropic', anthropicBody([['user', 'hi']], { system: ` - Primary working directory: ${repo}\n - Is a git repository: false` }));
      expect(identityOf({ request: said })).toMatchObject({ workDir: repo, workDirIsGitRepository: false });
      const unsaid = parseBody('anthropic', anthropicBody([['user', 'hi']], { system: ` - Primary working directory: ${join(repo, 'pkg')}` }));
      expect(identityOf({ request: unsaid })).toMatchObject({ workDir: join(repo, 'pkg'), workDirIsGitRepository: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('wire identity: the folder and words readers stay linear on hostile text', () => {
  // magpie's patterns are Go RE2 (linear); ported to a backtracking engine
  // they went quadratic or worse on these, while reading a body that is not
  // yet forwarded. Each must finish far inside the budget.
  const HOSTILE_LENGTH = 1_000_000;
  const BUDGET_MS = 1_000;
  const timed = (label: string, read: () => unknown) => {
    const startedAt = performance.now();
    read();
    expect(performance.now() - startedAt, label).toBeLessThan(BUDGET_MS);
  };

  it('finishes each reader on a megabyte of the text that backtracks', () => {
    const spaces = ' '.repeat(HOSTILE_LENGTH);
    timed('<cwd> then spaces', () => workDirSaidInText(`<cwd>a${spaces}`));
    timed('<cwd> spaces then a', () => workDirSaidInText(`<cwd>${spaces}a`));
    timed('git said over newlines', () => gitRepositorySaidInText('\n'.repeat(HOSTILE_LENGTH)));
    timed('git said over carriage returns', () => gitRepositorySaidInText('\r'.repeat(HOSTILE_LENGTH)));
    timed('<env> of newlines', () => workDirSaidInText(`<env>${'\n'.repeat(HOSTILE_LENGTH)}</env>`));
    timed('(was repeated', () => workDirSaidInText(`Primary working directory: /a${' (was '.repeat(HOSTILE_LENGTH / 6)}`));
    timed('unclosed reminders', () => userWordsInText('<system-reminder>'.repeat(HOSTILE_LENGTH / 17)));
    timed('one closed then unclosed reminders', () => userWordsInText(`<system-reminder>x</system-reminder>${'<system-reminder x'.repeat(HOSTILE_LENGTH / 18)}`));
    timed('AGENTS.md heading then spaces', () => userWordsInText(`# a.md instructions for x${spaces}`));
  });

  it('reads what magpie\'s patterns read', () => {
    expect(workDirSaidInText('<cwd>\n/Users/me/pi\n</cwd>')).toBe('/Users/me/pi');
    expect(workDirSaidInText('<cwd>  /a b  </cwd>')).toBe('/a b');
    expect(workDirSaidInText('<cwd>/a\n/b</cwd>')).toBeUndefined();
    expect(workDirSaidInText('<cwd> \n </cwd>')).toBeUndefined();
    expect(workDirSaidInText('Primary working directory: /y (was /x)')).toBe('/y');
    expect(workDirSaidInText('Primary working directory: /y (was /x) (was /w)')).toBe('/y');
    expect(workDirSaidInText('Primary working directory: /y (was /x) later')).toBe('/y (was /x) later');
    expect(workDirSaidInText('<env>\n\t Working directory: /o\n</env>')).toBe('/o');
    expect(gitRepositorySaidInText('  - Is a git repository: true  \r\nnext')).toBe(true);
    expect(gitRepositorySaidInText(' - Is a git repository: true\n\n  Is directory a git repo: No\n')).toBe(false);
    expect(gitRepositorySaidInText('Is a git repository: true, mostly')).toBeUndefined();

    expect(userWordsInText('<system-reminder>a</system-reminder>hi<system-reminder source="x">b</system-reminder> there')).toBe('hi there');
    expect(userWordsInText('<system-reminder\nsource="x">b</system-reminder>hi')).toBe('hi');
    expect(userWordsInText('<system-reminders>keep</system-reminder>')).toBe('');
    expect(userWordsInText('ask <system-reminder>never closed')).toBe('ask <system-reminder>never closed');
    expect(userWordsInText('# AGENTS.md instructions for /Users/me/app  \n\nRun it')).toBe('');
    expect(userWordsInText('# AGENTS.md instructions for /Users/me/app')).toBe('# AGENTS.md instructions for /Users/me/app');
    expect(userWordsInText('# AGENTS.md instructions for /app\r\nRun it')).toBe('# AGENTS.md instructions for /app\r\nRun it');
    // codex-cli 0.162.1 drops the "for <path>" (seen live).
    expect(userWordsInText('# AGENTS.md instructions\n\n<INSTRUCTIONS>\nRun the tests.\n</INSTRUCTIONS>')).toBe('');
  });
});

describe('wire identity: user words and turn start', () => {
  it('what the agent put in is not the user\'s words (magpie user_said_test.go:179-191)', () => {
    for (const text of [goalContinuation, taskNotification, pluginRef, agentList, zcodeAgentList, zcodeTodo, envContext, codexAgents,
      '<turn_aborted>\nThe user interrupted.\n</turn_aborted>', `${inAppBrowser}## My request:\n`]) {
      expect(userWordsInText(text), text.slice(0, 40)).toBe('');
    }
    expect(userWordsInText('fix it')).toBe('fix it');
    expect(userWordsInText(`${goalContinuation}\nfix it`)).toBe('fix it');
    expect(userWordsInText(`${inAppBrowser}## My request for Codex:\nfix it`)).toBe('fix it');
  });

  it('turn start and within (magpie user_said_test.go:52-94)', () => {
    const ask = '合并远程分支，推到 master';
    const call: [string, string] = ['assistant', '[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]'];
    const result: [string, string] = ['user', '[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]'];
    const answer: [string, string] = ['assistant', 'done'];
    const user = (...texts: string[]): [string, string] => ['user', JSON.stringify(texts.map(text => ({ type: 'text', text })))];
    const cases: Array<[string, Array<[string, string]>, number, boolean]> = [
      ['task notification after a tool round', [user(ask), call, result, answer, user(taskNotification)], 1, true],
      ['goal check-in', [user(ask), call, result, answer, user(goalCheckIn)], 1, true],
      ["ZCode's todo nudge, bare", [user(ask), call, result, answer, user(zcodeTodo)], 1, true],
      ['todo nudge in a reminder', [user(ask), call, result, answer, user(`<system-reminder>\n${zcodeTodo}\n</system-reminder>`)], 1, true],
      ['agent list', [user(ask), call, result, answer, user(agentList)], 1, true],
      ["ZCode's agent list", [user(ask), call, result, answer, user(zcodeAgentList)], 1, true],
      ["ZCode's goal continuation", [user(ask), answer, user(goalContinuation)], 1, true],
      ['after a tool result, no answer', [user(ask), call, result, user(taskNotification)], 1, true],
      ["right after the user's words", [user(ask), user(pluginRef), user(agentList)], 1, false],
      ["the user's next words", [user(ask), answer, user(taskNotification), answer, user('继续 不要全量跑单元测试')], 2, false],
      ['Codex context alone', [user(codexAgents, envContext, 'fix the bug'), answer, user(envContext)], 1, true],
      ["Codex app's context and request", [user(envContext, 'fix the bug'), answer, user(`${inAppBrowser}## My request for Codex:\nnow the test`)], 2, false],
      ["Codex app's context alone", [user(envContext, 'fix the bug'), answer, user(`${inAppBrowser}## My request for Codex:\n`)], 1, true],
      ['nothing said yet', [user(envContext)], 0, false],
    ];
    for (const [name, messages, userTurnOrdinal, withinTurn] of cases) {
      const request = parseBody('anthropic', anthropicBody(messages));
      expect(userTurnPositionOfRequest(request), name).toEqual({ userTurnOrdinal, withinTurn });
      expect(identityOf({ request }).turnStart, name).toBe(userTurnOrdinal > 0 && !withinTurn);
    }
  });

  it('Codex sending its context again after the cwd changed is within the turn (magpie user_said_test.go:84-93)', () => {
    const item = (role: string, text: string) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
    const body = JSON.stringify({ model: 'm', input: [
      item('user', codexAgents), item('user', envContext), item('user', 'fix the bug'), item('assistant', 'fixed'),
      item('developer', '<permissions instructions>sandboxed</permissions instructions>'),
      item('user', envContext.replace('/Users/me/app', '/Users/me/app/web')),
    ] });
    const request = parseBody('openai-responses', body);
    expect(userTurnPositionOfRequest(request)).toEqual({ userTurnOrdinal: 1, withinTurn: true });
    const identity = identityOf({ agentId: 'codex', suffixPath: '/v1/responses', request });
    expect(identity).toMatchObject({ userWords: 'fix the bug', turnStart: false, workDir: '/Users/me/app/web' });
  });

  it('the recorder keeps what the agent put in as context, not as words said', () => {
    const request = parseBody('anthropic', anthropicBody([['user', JSON.stringify([{ type: 'text', text: envContext }, { type: 'text', text: codexAgents }, { type: 'text', text: 'fix it' }])], ['assistant', '<b>bold</b> answer']]));
    const reply = { text: '', toolCalls: [], thinking: '', sealed: [], usage: emptyWireUsage(), stop: null, endedCleanly: true };
    expect(toRecorderParts(request, reply).input).toEqual([
      { role: 'user', kind: 'context', text: envContext },
      { role: 'user', kind: 'context', text: codexAgents },
      { role: 'user', kind: 'text', text: 'fix it' },
      { role: 'assistant', kind: 'text', text: '<b>bold</b> answer' },
    ]);
  });
});

describe('wire identity: launch registry', () => {
  it('launch ids are 26 base32 characters; launches expire after 24 h idle and stay alive while used', () => {
    let now = 1_000_000;
    const registry = new WireLaunchRegistry({ now: () => now });
    const launch = registry.create({ agentId: 'aider', cwd: '/Users/me/app' });
    expect(launch.launchId).toMatch(LAUNCH_ID_PATTERN);
    expect(registry.create({ agentId: 'aider', cwd: '/x' }).launchId).not.toBe(launch.launchId);
    now += 23 * 60 * 60 * 1000;
    expect(registry.use(launch.launchId)?.cwd).toBe('/Users/me/app');
    now += 23 * 60 * 60 * 1000;
    expect(registry.use(launch.launchId)).toBeDefined();
    now += 24 * 60 * 60 * 1000 + 1;
    expect(registry.use(launch.launchId)).toBeUndefined();
  });

  it('holds at most maxLiveLaunches, forgetting the least recently used', () => {
    const registry = new WireLaunchRegistry({ maxLiveLaunches: 2 });
    const first = registry.create({ agentId: 'aider', cwd: '/1' });
    const second = registry.create({ agentId: 'aider', cwd: '/2' });
    expect(registry.use(first.launchId)).toBeDefined();
    const third = registry.create({ agentId: 'aider', cwd: '/3' });
    expect(registry.size).toBe(2);
    expect(registry.use(second.launchId)).toBeUndefined();
    expect(registry.use(first.launchId)?.cwd).toBe('/1');
    expect(registry.use(third.launchId)?.cwd).toBe('/3');
  });

  it('splits /l/<launchId> off the suffix', () => {
    const launchId = 'a'.repeat(26);
    expect(splitLaunchSegment(`/l/${launchId}/v1/messages`)).toEqual({ launchId, upstreamSuffixPath: '/v1/messages' });
    expect(splitLaunchSegment(`/l/${launchId}`)).toEqual({ launchId, upstreamSuffixPath: '' });
    expect(splitLaunchSegment('/l/short/v1/messages')).toEqual({ launchId: null, upstreamSuffixPath: '/l/short/v1/messages' });
    expect(splitLaunchSegment('/v1/messages')).toEqual({ launchId: null, upstreamSuffixPath: '/v1/messages' });
  });
});

describe('wire identity: turn tracker', () => {
  const trackers: TurnTracker[] = [];
  afterEach(() => {
    for (const tracker of trackers.splice(0)) tracker.dispose();
  });

  function newTracker(options: Partial<ConstructorParameters<typeof TurnTracker>[0]> = {}) {
    const turnEnds: Array<WireTurnEnd & { firedAt: number }> = [];
    const staleSessions: WireSessionStale[] = [];
    const tracker = new TurnTracker({
      onTurnEnd: turnEnd => turnEnds.push({ ...turnEnd, firedAt: Date.now() }),
      onSessionStale: stale => staleSessions.push(stale),
      staleSweepIntervalMs: 0,
      ...options,
    });
    trackers.push(tracker);
    return { tracker, turnEnds, staleSessions };
  }

  const turn = { agentId: 'claude-code', sessionId: 's1', kind: 'turn' as const, workDir: '/Users/u/work/magpie' };
  const subagent = { ...turn, kind: 'subagent' as const };
  const helper = { ...turn, kind: 'helper:title' as const };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('a final reply with nothing in flight ends the turn after 4 s of quiet', async () => {
    expect(TURN_QUIET_MS).toBe(4_000);
    const { tracker, turnEnds } = newTracker();
    tracker.begin(turn);
    tracker.end(turn, false); // called a tool
    tracker.begin(turn);
    const endedAt = Date.now();
    tracker.end(turn, true);
    await sleep(3_700);
    expect(turnEnds).toHaveLength(0);
    await sleep(800);
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0].firedAt - endedAt).toBeGreaterThanOrEqual(TURN_QUIET_MS - 50);
    expect(turnEnds[0].firedAt - endedAt).toBeLessThan(TURN_QUIET_MS + 400);
    expect(turnEnds[0]).toMatchObject({ agentId: 'claude-code', sessionId: 's1', workDir: '/Users/u/work/magpie' });
  }, 10_000);

  it('a subagent\'s or helper\'s last reply does not end the parent turn, and a new request stops the quiet timer', async () => {
    const { tracker, turnEnds } = newTracker({ turnQuietMs: 100 });
    tracker.begin(turn);
    tracker.end(turn, false); // the parent's reply spawned the subagent
    tracker.begin(subagent);
    tracker.end(subagent, true);
    tracker.begin(helper);
    tracker.end(helper, true);
    await sleep(250);
    expect(turnEnds).toHaveLength(0);
    tracker.begin(turn);
    tracker.end(turn, true);
    await sleep(50);
    tracker.begin(turn); // the agent went on within the quiet window
    await sleep(200);
    expect(turnEnds).toHaveLength(0);
    tracker.end(turn, true);
    await sleep(250);
    expect(turnEnds).toHaveLength(1);
  });

  it('a request still in flight holds the turn open, whatever another\'s reply was', async () => {
    const { tracker, turnEnds } = newTracker({ turnQuietMs: 50 });
    tracker.begin(turn);
    tracker.begin(turn);
    tracker.end(turn, true);
    await sleep(150);
    expect(turnEnds).toHaveLength(0);
    tracker.end(turn, true);
    await sleep(150);
    expect(turnEnds).toHaveLength(1);
  });

  it('a session idle 30 minutes with nothing in flight is stale; one in flight is not', () => {
    let now = 0;
    const { tracker, staleSessions } = newTracker({ now: () => now });
    tracker.begin(turn);
    tracker.end(turn, false);
    const other = { ...turn, sessionId: 's2' };
    tracker.begin(other); // still in flight
    now += SESSION_STALE_MS + 1;
    tracker.sweepStaleSessions();
    expect(staleSessions).toEqual([{ agentId: 'claude-code', sessionId: 's1', lastActivityAt: 0 }]);
    expect(tracker.trackedSessionCount).toBe(1);
    // A stale session's next request starts it over.
    tracker.begin(turn);
    expect(tracker.trackedSessionCount).toBe(2);
  });
});
