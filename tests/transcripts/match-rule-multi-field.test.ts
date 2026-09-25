import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { matchesRule, resolveFields } from '../../src/services/transcripts/field-utils.js';
import type { MatchRule, TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

// Cross-field matching (#4211): every operator on a MatchRule was applied to the
// single value its `path` selects, so a rule could not constrain one field by
// another. Codex 0.155 emits the conversation as response items and injects a
// role:user preamble ahead of the real prompt, so the correct rule is two
// fields wide ("role == user" AND "text is not an injected block") and the
// shipped codex schema could not express it at all.
describe('matchesRule cross-field rules', () => {
  const schema: TranscriptSchema = { name: 'test', eventTypePath: 'type', events: [] };

  const injectedPreamble = {
    type: 'event',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ text: '<recommended_plugins>\nHere is a list of plugins that are available but not installed' }],
    },
  };
  const realPrompt = {
    type: 'event',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ text: 'Repeat this token back exactly once: ZORBAX-QQ-7731' }],
    },
  };
  const assistantReply = {
    type: 'event',
    payload: { type: 'message', role: 'assistant', content: [{ text: 'ZORBAX-QQ-7731' }] },
  };
  const approvalSubagent = {
    type: 'event',
    payload: {
      type: 'user_message',
      message: 'The following is the Codex agent history whose request action you are ...',
    },
  };

  it('leaves single-path rules behaving exactly as before', () => {
    expect(matchesRule(assistantReply, { path: 'payload.type', equals: 'message' }, schema)).toBe(true);
    expect(matchesRule(approvalSubagent, { path: 'payload.type', equals: 'user_message' }, schema)).toBe(true);
    expect(matchesRule(approvalSubagent, { path: 'payload.role', equals: 'user' }, schema)).toBe(false);
  });

  it('matches a rule that constrains one field by another', () => {
    const rule: MatchRule = {
      all: [
        { path: 'payload.type', equals: 'message' },
        { path: 'payload.role', equals: 'user' },
        { path: 'payload.content[0].text', not_contains: '<recommended_plugins>' },
      ],
    };
    expect(matchesRule(realPrompt, rule, schema)).toBe(true);
    expect(matchesRule(injectedPreamble, rule, schema)).toBe(false);
    expect(matchesRule(assistantReply, rule, schema)).toBe(false);
  });

  it('requires every sub-rule of `all` to pass', () => {
    const rule: MatchRule = {
      all: [
        { path: 'payload.role', equals: 'user' },
        { path: 'payload.role', equals: 'assistant' },
      ],
    };
    expect(matchesRule(realPrompt, rule, schema)).toBe(false);
  });

  it('passes `any` when one sub-rule matches', () => {
    const rule: MatchRule = {
      any: [
        { path: 'payload.role', equals: 'user' },
        { path: 'payload.role', equals: 'assistant' },
      ],
    };
    expect(matchesRule(realPrompt, rule, schema)).toBe(true);
    expect(matchesRule(injectedPreamble, rule, schema)).toBe(true);
    expect(matchesRule(approvalSubagent, rule, schema)).toBe(false);
  });

  it('ANDs `all` with the operators declared on the parent rule', () => {
    const rule: MatchRule = {
      path: 'payload.type',
      equals: 'message',
      all: [{ path: 'payload.role', equals: 'user' }],
    };
    expect(matchesRule(realPrompt, rule, schema)).toBe(true);
    expect(matchesRule(assistantReply, rule, schema)).toBe(false);
  });

  it('composes nested rule trees', () => {
    const rule: MatchRule = {
      all: [
        {
          any: [
            { path: 'payload.role', equals: 'user' },
            { path: 'payload.role', equals: 'assistant' },
          ],
        },
        { all: [{ path: 'payload.type', equals: 'message' }] },
      ],
    };
    expect(matchesRule(realPrompt, rule, schema)).toBe(true);
    expect(matchesRule(approvalSubagent, rule, schema)).toBe(false);
  });

  it('treats an empty `any` as matching nothing and an empty `all` as vacuous', () => {
    expect(matchesRule(realPrompt, { all: [] }, schema)).toBe(true);
    expect(matchesRule(realPrompt, { any: [] }, schema)).toBe(false);
  });
});

interface ExampleSchema {
  version?: string;
  events: Array<{ name: string; match?: MatchRule; action: string; fields?: Record<string, never> }>;
}

describe('shipped codex schema in transcript-watch.example.json', () => {
  const example = JSON.parse(
    readFileSync(join(import.meta.dir, '..', '..', 'transcript-watch.example.json'), 'utf8'),
  ) as { schemas: Record<string, ExampleSchema> };

  const codex = example.schemas.codex;
  const userMessage = codex.events.find(event => event.name === 'user-message');
  const assistantMessage = codex.events.find(event => event.name === 'assistant-message');

  const responseItem = (role: string, text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ text }] },
  });

  const ctx = {
    watch: { name: 'codex', path: '~/.codex/sessions/**/*.jsonl', schema: 'codex' } as WatchTarget,
    schema: { name: 'codex', events: [] } as TranscriptSchema,
  };

  it('stores the real user prompt and rejects the preamble Codex sends first', () => {
    const rule = userMessage!.match!;
    const prompt = responseItem('user', 'Repeat this token back exactly once: ZORBAX-QQ-7731');

    expect(matchesRule(prompt, rule, ctx.schema)).toBe(true);
    expect(resolveFields(userMessage!.fields, prompt, ctx)).toEqual({
      prompt: 'Repeat this token back exactly once: ZORBAX-QQ-7731',
    });

    // The injected preamble, the developer preamble, and the approval
    // sub-agent's user_message must all be rejected: the first is the wrongly
    // stored value from #4211, the others are not user turns at all.
    expect(matchesRule(responseItem('user', '<recommended_plugins>\nHere is a list of plugins'), rule, ctx.schema)).toBe(false);
    expect(matchesRule(responseItem('developer', '<skills_instructions> ...'), rule, ctx.schema)).toBe(false);
    expect(matchesRule(
      { type: 'event', payload: { type: 'user_message', message: 'The following is the Codex agent history ...' } },
      rule,
      ctx.schema,
    )).toBe(false);
  });

  it('reads assistant text from the same response-item shape', () => {
    const rule = assistantMessage!.match!;
    const reply = responseItem('assistant', 'ZORBAX-QQ-7731');
    expect(matchesRule(reply, rule, ctx.schema)).toBe(true);
    expect(resolveFields(assistantMessage!.fields, reply, ctx)).toEqual({ message: 'ZORBAX-QQ-7731' });
    expect(matchesRule(responseItem('user', 'hi'), rule, ctx.schema)).toBe(false);
  });
});
