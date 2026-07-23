import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt } from '../../src/sdk/prompts.js';

describe('buildObservationPrompt', () => {
  it('instructs the observer to avoid prose skip responses', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks, or an empty response');
    expect(prompt).toContain('Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });
});

describe('buildObservationPrompt payload encoding', () => {
  it('renders stored JSON text as readable pretty-printed JSON, not escaped soup', () => {
    // ingestObservation stores tool payloads as JSON text (a single
    // JSON.stringify). The providers must pass that text through untouched;
    // a second JSON.stringify at the call site used to double-encode it and
    // the prompt carried `{\"file_path\":...}` instead of readable JSON.
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: '/repo/src/app.ts' }),
      tool_output: JSON.stringify({ content: 'line one\nline "two"' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('"file_path": "/repo/src/app.ts"');
    expect(prompt).not.toContain('\\"file_path\\"');
    // Content strings keep single-level JSON escapes, never double (`\\n`, `\\\"`).
    expect(prompt).toContain('"content": "line one\\nline \\"two\\""');
    expect(prompt).not.toContain('\\\\n');
  });

  it('survives a double-encoded payload without re-escaping it', () => {
    // Defense in depth: if a caller does double-encode, the first parse
    // yields the inner JSON text (a string), which must embed raw rather
    // than being JSON-escaped a second time.
    const stored = JSON.stringify({ command: 'echo "hi"' });
    const prompt = buildObservationPrompt({
      id: 2,
      tool_name: 'Bash',
      tool_input: JSON.stringify(stored),
      tool_output: JSON.stringify(JSON.stringify({ stdout: 'hi' })),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain(stored);
    expect(prompt).not.toContain('\\\\\"');
  });

  it('embeds plain-text (non-JSON) tool output raw', () => {
    const prompt = buildObservationPrompt({
      id: 3,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'ls' }),
      tool_output: 'total 8\ndrwxr-xr-x  2 user  staff',
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('total 8\ndrwxr-xr-x  2 user  staff');
    expect(prompt).not.toContain('total 8\\n');
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

  it('truncates an oversized plain-string field with an elided marker', () => {
    const huge = 'HEAD_SENTINEL' + 'B'.repeat(60_000) + 'TAIL_SENTINEL';
    const prompt = buildObservationPrompt({
      id: 3,
      tool_name: 'Bash',
      tool_input: JSON.stringify({ command: 'cat big.log' }),
      tool_output: huge,
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('reason="oversize"');
    expect(prompt).toContain('HEAD_SENTINEL');
    expect(prompt).toContain('TAIL_SENTINEL');
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
