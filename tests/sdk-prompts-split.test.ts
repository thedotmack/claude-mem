/**
 * Tests for SplitPrompt interface and prompt caching support
 *
 * Validates that buildInitPrompt and buildContinuationPrompt return
 * { staticPrefix, dynamicContext } with the correct properties for
 * Anthropic prompt cache hits.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildInitPrompt,
  buildContinuationPrompt,
  escapeXmlText,
} from '../src/sdk/prompts.js';
import type { ModeConfig } from '../src/services/domain/types.js';

// Minimal mock ModeConfig — only the fields referenced by the prompt builders
const mockMode: ModeConfig = {
  name: 'code',
  description: 'test mode',
  version: '1.0.0',
  observation_types: [
    { id: 'discovery', label: 'Discovery', description: '', emoji: '', work_emoji: '' },
    { id: 'bugfix', label: 'Bugfix', description: '', emoji: '', work_emoji: '' },
  ],
  observation_concepts: [],
  prompts: {
    system_identity: 'You are a memory agent.',
    observer_role: 'Observe tool use.',
    spatial_awareness: 'You see the working directory.',
    recording_focus: 'Record findings.',
    skip_guidance: 'Skip trivial tool use.',
    output_format_header: 'Output XML:',
    type_guidance: 'Choose the right type.',
    concept_guidance: 'Tag with concepts.',
    field_guidance: 'Fill all fields.',
    format_examples: '',
    footer: 'End of instructions.',
    header_memory_start: '=== MEMORY START ===',
    header_memory_continued: '=== MEMORY CONTINUED ===',
    header_summary_checkpoint: '',
    continuation_greeting: 'Welcome back, memory agent.',
    continuation_instruction: 'Continue observing.',
    summary_instruction: '',
    summary_context_label: '',
    summary_format_instruction: '',
    summary_footer: '',
    xml_title_placeholder: '[title]',
    xml_subtitle_placeholder: '[subtitle]',
    xml_fact_placeholder: '[fact]',
    xml_narrative_placeholder: '[narrative]',
    xml_concept_placeholder: '[concept]',
    xml_file_placeholder: '[file]',
    xml_summary_request_placeholder: '',
    xml_summary_investigated_placeholder: '',
    xml_summary_learned_placeholder: '',
    xml_summary_completed_placeholder: '',
    xml_summary_next_steps_placeholder: '',
    xml_summary_notes_placeholder: '',
  },
};

describe('escapeXmlText', () => {
  it('should escape ampersands', () => {
    expect(escapeXmlText('a & b')).toBe('a &amp; b');
  });

  it('should escape angle brackets', () => {
    expect(escapeXmlText('fix <Button> component')).toBe('fix &lt;Button&gt; component');
  });

  it('should escape all special chars together', () => {
    expect(escapeXmlText('<div class="a&b">')).toBe('&lt;div class="a&amp;b"&gt;');
  });

  it('should return plain text unchanged', () => {
    expect(escapeXmlText('hello world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(escapeXmlText('')).toBe('');
  });
});

describe('buildInitPrompt — SplitPrompt', () => {
  it('should return an object with staticPrefix and dynamicContext', () => {
    const result = buildInitPrompt('my-project', 'sess-1', 'fix a bug', mockMode);

    expect(result).toHaveProperty('staticPrefix');
    expect(result).toHaveProperty('dynamicContext');
    expect(typeof result.staticPrefix).toBe('string');
    expect(typeof result.dynamicContext).toBe('string');
  });

  it('staticPrefix should be identical across calls with different prompts', () => {
    const a = buildInitPrompt('proj', 'sess-1', 'first prompt', mockMode);
    const b = buildInitPrompt('proj', 'sess-2', 'completely different prompt', mockMode);

    expect(a.staticPrefix).toBe(b.staticPrefix);
  });

  it('dynamicContext should change when userPrompt changes', () => {
    const a = buildInitPrompt('proj', 'sess-1', 'prompt A', mockMode);
    const b = buildInitPrompt('proj', 'sess-2', 'prompt B', mockMode);

    expect(a.dynamicContext).not.toBe(b.dynamicContext);
  });

  it('dynamicContext should contain the user prompt wrapped in XML', () => {
    const result = buildInitPrompt('proj', 'sess-1', 'my request', mockMode);

    expect(result.dynamicContext).toContain('<user_request>my request</user_request>');
    expect(result.dynamicContext).toContain('<observed_from_primary_session>');
  });

  it('should XML-escape special characters in userPrompt', () => {
    const result = buildInitPrompt('proj', 'sess-1', 'fix <Button> & <Input>', mockMode);

    expect(result.dynamicContext).toContain('&lt;Button&gt;');
    expect(result.dynamicContext).toContain('&amp;');
    expect(result.dynamicContext).not.toContain('<Button>');
  });

  it('staticPrefix should not contain userPrompt content', () => {
    const result = buildInitPrompt('proj', 'sess-1', 'unique-marker-12345', mockMode);

    expect(result.staticPrefix).not.toContain('unique-marker-12345');
  });

  it('staticPrefix should not contain requested_at timestamp', () => {
    const result = buildInitPrompt('proj', 'sess-1', 'test', mockMode);

    expect(result.staticPrefix).not.toContain('<requested_at>');
  });
});

describe('buildContinuationPrompt — SplitPrompt', () => {
  it('should return an object with staticPrefix and dynamicContext', () => {
    const result = buildContinuationPrompt('continue work', 2, 'sess-1', mockMode);

    expect(result).toHaveProperty('staticPrefix');
    expect(result).toHaveProperty('dynamicContext');
  });

  it('staticPrefix should be identical across calls with different prompts', () => {
    const a = buildContinuationPrompt('prompt A', 2, 'sess-1', mockMode);
    const b = buildContinuationPrompt('prompt B', 3, 'sess-2', mockMode);

    expect(a.staticPrefix).toBe(b.staticPrefix);
  });

  it('dynamicContext should change when userPrompt changes', () => {
    const a = buildContinuationPrompt('prompt A', 2, 'sess-1', mockMode);
    const b = buildContinuationPrompt('prompt B', 2, 'sess-1', mockMode);

    expect(a.dynamicContext).not.toBe(b.dynamicContext);
  });

  it('should XML-escape special characters in userPrompt', () => {
    const result = buildContinuationPrompt('add <form action="/">&submit', 2, 'sess-1', mockMode);

    expect(result.dynamicContext).toContain('&lt;form');
    expect(result.dynamicContext).toContain('&amp;submit');
  });

  it('staticPrefix should not contain requested_at timestamp', () => {
    const result = buildContinuationPrompt('test', 2, 'sess-1', mockMode);

    expect(result.staticPrefix).not.toContain('<requested_at>');
  });
});

describe('Provider interop — concatenation produces valid prompt', () => {
  it('init: concatenated output should contain both static and dynamic parts', () => {
    const result = buildInitPrompt('proj', 'sess-1', 'test prompt', mockMode);
    const concatenated = result.staticPrefix + '\n' + result.dynamicContext;

    expect(concatenated).toContain('You are a memory agent.');
    expect(concatenated).toContain('<user_request>test prompt</user_request>');
  });

  it('continuation: concatenated output should contain both static and dynamic parts', () => {
    const result = buildContinuationPrompt('test prompt', 2, 'sess-1', mockMode);
    const concatenated = result.staticPrefix + '\n' + result.dynamicContext;

    expect(concatenated).toContain('Welcome back, memory agent.');
    expect(concatenated).toContain('<user_request>test prompt</user_request>');
  });
});
