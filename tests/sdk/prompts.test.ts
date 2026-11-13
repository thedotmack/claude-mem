import { describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  OBS_PROMPT_FIELD_MAX_CHARS,
  buildContinuationPrompt,
  buildInitPrompt,
  buildObservationPrompt,
  buildSummaryPrompt,
  stripImagePayloadsFromField,
} from '../../src/sdk/prompts.js';
import type { ModeConfig } from '../../src/services/domain/types.js';
import { WAITING_FOR } from '../../src/services/work-view/waiting-for.mjs';

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
  it('withholds native image bytes in whitespace-prefixed nested JSON while retaining the caption', () => {
    const bytes = 'iVBORw0KGgo' + 'A'.repeat(4000);
    const output = { stdout: ' \r\n\t' + JSON.stringify({ content: [
      { type: 'text', text: 'Viewport ready' },
      { type: 'image', data: bytes, mimeType: 'image/png' },
    ] }) };
    const prompt = buildObservationPrompt({ id: 1, tool_name: 'Bash', tool_input: '{}',
      tool_output: JSON.stringify(output), created_at_epoch: Date.now(), cwd: '/repo' });
    expect(prompt).toContain('Viewport ready');
    expect(prompt).toContain('image data withheld from the observer');
    expect(prompt).not.toContain(bytes);
    const plain = { stdout: ' \r\n\t{ "image_url": "an ordinary field", "count": 3 }' };
    expect(stripImagePayloadsFromField(plain)).toBe(plain);
  });

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

  it('asks what the turn waits for, naming every allowed word and the last message as the evidence', () => {
    const prompt = buildSummaryPrompt({
      id: 1,
      memory_session_id: 'memory-session-1',
      project: '/repo',
      user_prompt: 'summarize',
      last_assistant_message: 'Shall I merge it?',
    }, summaryMode);
    const tag = /<waiting_for>\[([\s\S]*?)\]<\/waiting_for>\n<\/summary>/.exec(prompt)?.[1] ?? '';

    for (const word of WAITING_FOR) expect(tag).toContain(`${word} (`);
    expect(tag).toContain("judged only from the observed agent's last message to the user");
    expect(tag).toContain('write nothing only if the turn made no work product');
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

// #5023: a fresh observer generation opens with the init or continuation
// prompt, and the 100000-char generation budget is checked before its first
// observation, so the user's request in it is bounded like one tool field.
describe('framing prompts bound the user request (#5023)', () => {
  const CODE_MODE = JSON.parse(readFileSync(join(import.meta.dir, '../../plugin/modes/code.json'), 'utf8')) as ModeConfig;
  const hugePrompt = 'HEAD_SENTINEL' + 'p'.repeat(200_000) + 'TAIL_SENTINEL';
  const userRequestOf = (prompt: string): string => prompt.match(/<user_request>([\s\S]*?)<\/user_request>/)![1];
  const templateChars = (build: (userPrompt: string) => string): number => build('').length;

  const builders: Array<[string, (userPrompt: string) => string]> = [
    ['buildInitPrompt', userPrompt => buildInitPrompt('repo', 'content-5023', userPrompt, CODE_MODE)],
    ['buildContinuationPrompt', userPrompt => buildContinuationPrompt(userPrompt, 3, 'content-5023', CODE_MODE)],
  ];

  it.each(builders)('%s keeps the head and tail of a 200k-char prompt within the field limit', (_name, build) => {
    const prompt = build(hugePrompt);
    const request = userRequestOf(prompt);
    expect(request.startsWith('HEAD_SENTINEL')).toBe(true);
    expect(request.endsWith('TAIL_SENTINEL')).toBe(true);
    expect(request).toContain(`original_size_chars="${hugePrompt.length}" reason="oversize"`);
    expect(request.length).toBeLessThanOrEqual(OBS_PROMPT_FIELD_MAX_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(OBS_PROMPT_FIELD_MAX_CHARS + templateChars(build));
  });

  it.each(builders)('%s embeds a prompt within the limit unchanged', (_name, build) => {
    const fits = 'q'.repeat(OBS_PROMPT_FIELD_MAX_CHARS);
    expect(userRequestOf(build(fits))).toBe(fits);
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

  it('withholds image bytes, preserves the caption and MIME, and stays below the truncation cap', () => {
    const toolOutput = JSON.stringify({
      content: [
        { type: 'text', text: 'Took a screenshot of the viewport at 1280x720.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } },
      ],
    });
    for (const toolName of ['mcp__claude-in-chrome__computer', 'mcp__claude-in-chrome__browser_batch']) {
      const prompt = buildObservationPrompt({
        id: 1,
        tool_name: toolName,
        tool_input: JSON.stringify({ action: 'screenshot' }),
        tool_output: toolOutput,
        created_at_epoch: Date.now(),
        cwd: '/repo',
      });

      expect(/A{200,}/.test(prompt)).toBe(false);
      expect(prompt).not.toContain('iVBORw0KGgo');
      expect(prompt).toContain('Took a screenshot of the viewport');
      expect(prompt).toContain('image data withheld from the observer');
      expect(prompt).toContain('image/png');
      expect(prompt.length).toBeLessThan(2_000);
    }
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

describe('stripImagePayloadsFromField parses a nested JSON string only when it may hold an image', () => {
  const BASE64 = '/9j/4AAQSkZJRgABAQAAAQ' + 'A'.repeat(200_000);

  it('returns an image-free 300 KB JSON string untouched without parsing it', () => {
    // An accessibility tree mentions images in prose; that is not a payload.
    const rows = Array.from({ length: 3_000 }, (_, i) => ({ id: i, text: `image Igor ${i}`, path: `/assets/${i}.png` }));
    const nested = JSON.stringify({ rows });
    expect(nested.length).toBeGreaterThan(150_000);
    const field = { stdout: nested + ' '.repeat(Math.max(0, 300_000 - nested.length)) };
    const parse = spyOn(JSON, 'parse');
    try {
      expect(stripImagePayloadsFromField(field)).toBe(field);
      expect(parse).toHaveBeenCalledTimes(0);
    } finally {
      parse.mockRestore();
    }
  });

  it('still strips an image block nested two string levels deep, where its quotes are escaped', () => {
    const inner = JSON.stringify({ content: [{ type: 'image', data: BASE64 }], pad: 'p'.repeat(300) });
    const field = { stdout: JSON.stringify({ result: inner }) };
    const out = stripImagePayloadsFromField(field) as { stdout: string };

    expect(/A{200,}/.test(out.stdout)).toBe(false);
    expect(JSON.parse(JSON.parse(out.stdout).result).content[0]).toMatchObject({ type: 'image', bytes: BASE64.length });
  });
});
