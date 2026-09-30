import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt, buildSummaryPrompt } from '../../src/sdk/prompts.js';

const summaryMode = {
  prompts: {
    header_summary_checkpoint: 'summary checkpoint',
    summary_instruction: 'summarize the session',
    summary_context_label: 'last assistant message',
    summary_format_instruction: 'return summary XML',
    xml_summary_request_placeholder: 'request',
    xml_summary_investigated_placeholder: 'investigated',
    xml_summary_learned_placeholder: 'learned',
    xml_summary_completed_placeholder: 'completed',
    xml_summary_next_steps_placeholder: 'next steps',
    xml_summary_notes_placeholder: 'notes',
    summary_footer: 'summary footer',
  },
} as any;

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

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks, or <skip_summary reason="noise" />');
    expect(prompt).toContain('Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection');
    expect(prompt).toContain('Never reply with prose such as "Skipping", "No substantive tool executions"');
  });

  it('explains redacted markers in summary prompts', () => {
    const prompt = buildSummaryPrompt({
      id: 1,
      memory_session_id: 'memory-session-1',
      project: '/repo',
      user_prompt: 'summarize',
      last_assistant_message: "Used <redacted type='openai_key'/> during setup.",
    }, summaryMode);

    expect(prompt).toContain("Used <redacted type='openai_key'/> during setup.");
    expect(prompt).toContain(`If you see a "<redacted type='...'/>" marker`);
    expect(prompt).toContain('do not infer the literal value or copy the marker itself into generated memory content.');
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

describe('buildObservationPrompt image-payload stripping (#3730)', () => {
  const BASE64 = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(200_000);

  function screenshotOutcome() {
    return JSON.stringify({
      content: [
        { type: 'text', text: 'Took a screenshot of the viewport at 1280x720.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } },
      ],
    });
  }

  it('keeps no base64 run from an Anthropic image content block', () => {
    const prompt = buildObservationPrompt({
      id: 1,
      tool_name: 'mcp__claude-in-chrome__computer',
      tool_input: JSON.stringify({ action: 'screenshot' }),
      tool_output: screenshotOutcome(),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // Truncation alone did NOT solve this: it keeps the head and tail of an
    // oversized field, so a screenshot used to survive as thousands of
    // characters of base64 rather than as the caption beside it.
    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).not.toContain('iVBORw0KGgo');
  });

  it('keeps the text that sits beside the image', () => {
    const prompt = buildObservationPrompt({
      id: 2,
      tool_name: 'mcp__claude-in-chrome__computer',
      tool_input: JSON.stringify({ action: 'screenshot' }),
      tool_output: screenshotOutcome(),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // Stripping must not degrade into skipping: the caption is the part the
    // observer can actually narrate.
    expect(prompt).toContain('Took a screenshot of the viewport');
  });

  it('says what was removed instead of removing it silently', () => {
    const prompt = buildObservationPrompt({
      id: 3,
      tool_name: 'mcp__claude-in-chrome__computer',
      tool_input: JSON.stringify({ action: 'screenshot' }),
      tool_output: screenshotOutcome(),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('image data withheld from the observer');
    expect(prompt).toContain('image/png');
  });

  it('collapses the prompt far below the per-field truncation cap', () => {
    const prompt = buildObservationPrompt({
      id: 4,
      tool_name: 'mcp__claude-in-chrome__browser_batch',
      tool_input: JSON.stringify({ action: 'screenshot' }),
      tool_output: screenshotOutcome(),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    // The prompt is appended to session.conversationHistory and re-sent by
    // every later observation in the session, so this saving compounds.
    expect(prompt.length).toBeLessThan(2_000);
  });

  it('strips images nested inside arrays and objects', () => {
    const prompt = buildObservationPrompt({
      id: 5,
      tool_name: 'mcp__browser__batch',
      tool_input: JSON.stringify({ steps: [{ shot: { type: 'image', source: { data: BASE64 } } }] }),
      tool_output: JSON.stringify({
        results: { pages: [{ blocks: [{ type: 'image', source: { data: BASE64 } }] }] },
      }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(/A{200,}/.test(prompt)).toBe(false);
  });

  it('strips an OpenAI-style inlined data: URL', () => {
    const prompt = buildObservationPrompt({
      id: 6,
      tool_name: 'some_openai_tool',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify({
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + BASE64 } }],
      }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain('image data withheld from the observer');
  });

  it('leaves a plain http image URL alone — it is short and it carries signal', () => {
    const prompt = buildObservationPrompt({
      id: 7,
      tool_name: 'some_openai_tool',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify({
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/shot.png' } }],
      }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('https://example.com/shot.png');
  });

  it('does not touch ordinary tool output', () => {
    const prompt = buildObservationPrompt({
      id: 8,
      tool_name: 'exec_command',
      tool_input: JSON.stringify({ cmd: 'pwd' }),
      tool_output: JSON.stringify({ output: '/repo', type: 'image_of_the_day' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('/repo');
    expect(prompt).toContain('image_of_the_day');
    expect(prompt).not.toContain('withheld');
  });
});

describe('buildObservationPrompt keeps url-backed image sources (#3730 review)', () => {
  it('leaves an Anthropic url source alone, the same as the OpenAI branch does', () => {
    const prompt = buildObservationPrompt({
      id: 9,
      tool_name: 'mcp__browser__shot',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify({
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.com/shot.png' } },
        ],
      }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('https://example.com/shot.png');
    expect(prompt).not.toContain('withheld');
  });

  it('still elides an Anthropic source whose url is an inlined data: URL', () => {
    const prompt = buildObservationPrompt({
      id: 10,
      tool_name: 'mcp__browser__shot',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify({
        content: [
          { type: 'image', source: { type: 'url', url: 'data:image/png;base64,' + 'A'.repeat(100_000) } },
        ],
      }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain('image data withheld from the observer');
  });

  it('elides an uppercase DATA: URI the same as lowercase data:', () => {
    const prompt = buildObservationPrompt({
      id: 11,
      tool_name: 'mcp__browser__shot',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify({
        content: [
          { type: 'image', source: { type: 'url', url: 'DATA:image/png;base64,' + 'A'.repeat(100_000) } },
        ],
      }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain('image data withheld from the observer');
  });
});
