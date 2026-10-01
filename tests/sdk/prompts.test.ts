import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt, buildSummaryPrompt, stripImagePayloadsFromField } from '../../src/sdk/prompts.js';

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
    expect(prompt).toContain('Never reply with an empty response, or with prose such as "Skipping", "No substantive tool executions"');
    // The sentinel is the only no-op answer; anything else is re-asked once, then dropped.
    expect(prompt).toContain('Only <observation> blocks or the <skip_summary /> sentinel complete this tool use');
  });

  it('explains redaction markers only when the observed tool use carries one', () => {
    const base = {
      id: 1,
      tool_name: 'Bash',
      tool_output: JSON.stringify({ output: 'ok' }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    };
    const plain = buildObservationPrompt({ ...base, tool_input: JSON.stringify({ command: 'ls' }) });
    const redacted = buildObservationPrompt({
      ...base,
      tool_input: JSON.stringify({ command: "curl -H 'Authorization: Bearer <redacted type='openai_key'/>'" }),
    });
    expect(plain).not.toContain('<redacted type=\'...\'/>');
    expect(redacted).toContain(`If you see a "<redacted type='...'/>" marker`);
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

  it('offers the skip sentinel, not silence, when there is nothing to summarize', () => {
    const prompt = buildSummaryPrompt({
      id: 1,
      memory_session_id: 'memory-session-1',
      project: '/repo',
      user_prompt: 'summarize',
      last_assistant_message: 'Nothing happened.',
    }, summaryMode);

    expect(prompt).toContain('reply with exactly <skip_summary reason="nothing durable" /> instead of an empty response or prose');
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

describe('buildObservationPrompt strips the MCP image block shape', () => {
  // An MCP tool result carries the bytes on the block itself:
  // { type: 'image', data: '<base64>', mimeType } — no `source`, no `file`.
  const BASE64 = '/9j/4AAQSkZJRgABAQAAAQ' + 'A'.repeat(200_000);

  function mcpScreenshotOutcome() {
    return JSON.stringify({
      content: [
        { type: 'text', text: 'Browser tab: 1, Title: "katalog"' },
        { type: 'image', data: BASE64, mimeType: 'image/png', _meta: { 'codex/imageDetail': 'original' } },
      ],
      isError: false,
    });
  }

  it('keeps no base64 run from an MCP image block, and says what it withheld', () => {
    const prompt = buildObservationPrompt({
      id: 12,
      tool_name: 'mcp__cua_repl__js',
      tool_input: JSON.stringify({ code: 'await tab.screenshot()' }),
      tool_output: mcpScreenshotOutcome(),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain('Browser tab: 1');
    expect(prompt).toContain('image data withheld from the observer');
    expect(prompt).toContain(String(BASE64.length));
    expect(prompt).toContain('image/png');
  });

  it('leaves an image block whose data is not a string alone', () => {
    const prompt = buildObservationPrompt({
      id: 13,
      tool_name: 'mcp__cua_repl__js',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify({ content: [{ type: 'image', data: { ref: 'frame-1' } }] }),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });

    expect(prompt).toContain('frame-1');
    expect(prompt).not.toContain('image data withheld from the observer');
  });
});

describe('buildObservationPrompt elides an inlined data:image URL wherever it sits', () => {
  // A browser tool can return a screenshot as a plain string field of an
  // ordinary object — no content block around it.
  const BASE64 = '/9j/4AAQSkZJRgABAQAAAQ' + 'A'.repeat(200_000);

  function build(toolOutput: unknown) {
    return buildObservationPrompt({
      id: 14,
      tool_name: 'mcp__cua_repl__js',
      tool_input: JSON.stringify({}),
      tool_output: JSON.stringify(toolOutput),
      created_at_epoch: Date.now(),
      cwd: '/repo',
    });
  }

  it('replaces the payload with a marker that keeps the mime type and byte count', () => {
    const prompt = build({
      _meta: { 'codex/toolSurface': { screenshot: {
        pageUrl: 'http://127.0.0.1:8765/', tabId: '1', url: 'data:image/jpeg;base64,' + BASE64,
      } } },
    });

    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain(`data:image/jpeg;base64,<elided ${BASE64.length} bytes>`);
    expect(prompt).toContain('http://127.0.0.1:8765/');
    expect(prompt).toContain('"tabId": "1"');
  });

  it('elides an uppercase DATA: URL in a string the same way', () => {
    const prompt = build({ shots: ['DATA:image/png;base64,' + BASE64] });

    expect(/A{200,}/.test(prompt)).toBe(false);
    expect(prompt).toContain(`<elided ${BASE64.length} bytes>`);
  });

  it('leaves a small data URL alone — an icon is cheap and may carry signal', () => {
    const icon = 'data:image/png;base64,' + 'B'.repeat(100);
    const prompt = build({ favicon: icon });

    expect(prompt).toContain(icon);
  });

  it('leaves a data URL that is not an image alone', () => {
    const prompt = build({ note: 'data:text/plain;base64,' + 'C'.repeat(2_000) });

    expect(/C{2000}/.test(prompt)).toBe(true);
  });
});

describe('stripImagePayloadsFromField looks inside string values that are themselves JSON', () => {
  // A tool result can reach the observer serialized twice, or carry its
  // content blocks as JSON text inside a string field. The image is then not
  // an object in the parsed field, and no shape matched it.
  const BASE64 = '/9j/4AAQSkZJRgABAQAAAQ' + 'A'.repeat(200_000);
  const result = {
    content: [
      { type: 'text', text: 'Browser tab: 1, Title: "katalog"' },
      { type: 'image', data: BASE64, mimeType: 'image/png' },
    ],
    isError: false,
  };

  it('strips inside a double-encoded field', () => {
    const field = JSON.stringify(JSON.stringify(result));
    const out = stripImagePayloadsFromField(field);

    expect(typeof out).toBe('string');
    expect(/A{200,}/.test(out as string)).toBe(false);
    const inner = JSON.parse(out as string);
    expect(inner.content[0].text).toContain('Browser tab: 1');
    expect(inner.content[1]).toMatchObject({ type: 'image', bytes: BASE64.length, mimeType: 'image/png' });
  });

  it('strips inside a JSON string nested in an ordinary field, and re-serializes only that string', () => {
    const field = JSON.stringify({ exitCode: 0, stdout: JSON.stringify(result) });
    const out = stripImagePayloadsFromField(field) as { exitCode: number; stdout: string };

    expect(out.exitCode).toBe(0);
    expect(typeof out.stdout).toBe('string');
    expect(/A{200,}/.test(out.stdout)).toBe(false);
    expect(JSON.parse(out.stdout).content[0].text).toContain('Browser tab: 1');
  });

  it('returns the field it was given when a nested JSON string has no image in it', () => {
    const nested = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` })) });
    const parsedField = { stdout: nested };
    expect(stripImagePayloadsFromField(parsedField)).toBe(parsedField);

    const textField = JSON.stringify(parsedField);
    expect(stripImagePayloadsFromField(textField)).toBe(textField);
  });

  it('does not parse a short string', () => {
    const short = JSON.stringify({ type: 'image', data: 'abc' });
    const parsedField = { note: short };
    expect(short.length).toBeLessThan(256);
    expect(stripImagePayloadsFromField(parsedField)).toBe(parsedField);
  });

  it('leaves a long string that only looks like JSON alone', () => {
    const parsedField = { stdout: '{ not json ' + 'x'.repeat(500) };
    expect(stripImagePayloadsFromField(parsedField)).toBe(parsedField);
  });
});

describe('stripImagePayloadsFromField is idempotent and bounded on the new shapes', () => {
  // A field is stripped twice: before the condense pass and again at prompt
  // build. The second pass must return what the first produced, unchanged.
  const BASE64 = '/9j/4AAQSkZJRgABAQAAAQ' + 'A'.repeat(200_000);
  const cases: Record<string, unknown> = {
    'MCP image block': { content: [{ type: 'image', data: BASE64, mimeType: 'image/png' }] },
    'data:image URL string': { screenshot: { tabId: '1', url: 'data:image/jpeg;base64,' + BASE64 } },
    'double-encoded field': JSON.stringify({ content: [{ type: 'image', data: BASE64 }] }),
  };

  for (const [name, payload] of Object.entries(cases)) {
    it(`a second pass leaves the ${name} as the first pass left it`, () => {
      const once = stripImagePayloadsFromField(JSON.stringify(payload));
      expect(once).not.toBe(JSON.stringify(payload));
      expect(stripImagePayloadsFromField(once)).toBe(once);
      expect(stripImagePayloadsFromField(JSON.stringify(once))).toBe(JSON.stringify(once));
    });
  }

  it('elides a data:image URL inside a nested JSON string', () => {
    const field = { stdout: JSON.stringify({ tabId: '1', url: 'data:image/png;base64,' + BASE64 }) };
    const out = stripImagePayloadsFromField(field) as { stdout: string };

    expect(JSON.parse(out.stdout)).toEqual({ tabId: '1', url: `data:image/png;base64,<elided ${BASE64.length} bytes>` });
  });

  it('parses a nested JSON string only within the depth guard', () => {
    const image = JSON.stringify({ type: 'image', data: BASE64 });
    const nest = (levels: number): unknown => {
      let node: unknown = image;
      for (let i = 0; i < levels; i++) node = { a: node };
      return node;
    };

    const shallow = nest(3);
    expect(stripImagePayloadsFromField(shallow)).not.toBe(shallow);
    const deep = nest(20);
    expect(stripImagePayloadsFromField(deep)).toBe(deep);
  });
});
