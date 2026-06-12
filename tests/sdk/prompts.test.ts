import { describe, expect, it } from 'bun:test';

import { buildObservationBatchPrompt, buildObservationPrompt } from '../../src/sdk/prompts.js';

describe('buildObservationPrompt', () => {
  it('instructs the observer to use XML no-op skip responses', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('exactly this no-op XML when nothing should be saved');
    expect(prompt).toContain('<type>skip</type>');
    expect(prompt).toContain('Skip routine status checks, repeated log/queue/database/process inspections');
    expect(prompt).toContain('Record debugging findings only when they materially change the diagnosis');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });

  it('can batch multiple nearby tool events into one observer prompt', () => {
    const prompt = buildObservationBatchPrompt([
      {
        id: 1,
        tool_name: 'Read',
        tool_input: JSON.stringify({ file_path: 'a.ts' }),
        tool_output: JSON.stringify({ content: 'const a = 1;' }),
        created_at_epoch: 1700000000000,
        cwd: '/repo',
      },
      {
        id: 2,
        tool_name: 'Grep',
        tool_input: JSON.stringify({ pattern: 'foo' }),
        tool_output: JSON.stringify({ matches: ['a.ts:1'] }),
        created_at_epoch: 1700000001000,
        cwd: '/repo',
      },
    ]);

    expect(prompt).toContain('<observed_from_primary_session_batch>');
    expect(prompt).toContain('<event_count>2</event_count>');
    expect(prompt).toContain('<tool_event index="1">');
    expect(prompt).toContain('<tool_event index="2">');
    expect(prompt).toContain('Combine related events into fewer observations');
    expect(prompt).toContain('<type>skip</type>');
  });
});

describe('buildObservationPrompt oversized field truncation (#2468)', () => {
  it('truncates an oversized outcome field with an elided marker, keeping head and tail', () => {
    const huge = 'HEAD_SENTINEL' + 'A'.repeat(60_000) + 'TAIL_SENTINEL';
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file: 'big.txt' }),
      tool_output: JSON.stringify({ content: huge }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('<elided');
    expect(prompt).toContain('reason="oversize"');
    // head and tail of the raw value are preserved
    expect(prompt).toContain('HEAD_SENTINEL');
    expect(prompt).toContain('TAIL_SENTINEL');
    // the oversized field is actually shrunk well below its raw 60k size
    expect(prompt.length).toBeLessThan(40_000);
  });

  it('leaves a small field untouched (no elided marker)', () => {
    const prompt = buildObservationPrompt({
      id: 2,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // The prompt always carries a static "<elided chars=... />" instruction line,
    // so assert on the actual truncation marker (reason="oversize") instead.
    expect(prompt).not.toContain('reason="oversize"');
  });
});
