import { describe, expect, it } from 'bun:test';

import { buildObservationPrompt, buildSummaryPrompt, type SDKSession } from '../../src/sdk/prompts.js';
import type { ModeConfig } from '../../src/services/domain/types.js';

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

// Minimal mock ModeConfig for testing buildSummaryPrompt
const mockMode: ModeConfig = {
  name: 'test-mode',
  description: 'Test mode',
  version: '1.0.0',
  observation_types: [],
  observation_concepts: [],
  prompts: {
    system_identity: 'You are a test observer.',
    spatial_awareness: 'Test spatial awareness.',
    observer_role: 'Test observer role.',
    recording_focus: 'Test recording focus.',
    skip_guidance: 'Test skip guidance.',
    type_guidance: 'Test type guidance.',
    concept_guidance: 'Test concept guidance.',
    field_guidance: 'Test field guidance.',
    output_format_header: 'Test output format header.',
    format_examples: 'Test format examples.',
    footer: 'Test footer.',
    xml_title_placeholder: '[title placeholder]',
    xml_subtitle_placeholder: '[subtitle placeholder]',
    xml_fact_placeholder: '[fact placeholder]',
    xml_narrative_placeholder: '[narrative placeholder]',
    xml_concept_placeholder: '[concept placeholder]',
    xml_file_placeholder: '[file placeholder]',
    xml_summary_request_placeholder: '[request placeholder]',
    xml_summary_investigated_placeholder: '[investigated placeholder]',
    xml_summary_learned_placeholder: '[learned placeholder]',
    xml_summary_completed_placeholder: '[completed placeholder]',
    xml_summary_next_steps_placeholder: '[next_steps placeholder]',
    xml_summary_notes_placeholder: '[notes placeholder]',
    header_memory_start: 'MEMORY PROCESSING START',
    header_memory_continued: 'MEMORY PROCESSING CONTINUED',
    header_summary_checkpoint: 'PROGRESS SUMMARY CHECKPOINT',
    continuation_greeting: 'Hello test agent.',
    continuation_instruction: 'Continue observing.',
    summary_instruction: 'Write a progress summary.',
    summary_context_label: "Claude's Response:",
    summary_format_instruction: 'Respond in this XML format:',
    summary_footer: 'End of summary.',
  },
};

describe('buildSummaryPrompt', () => {
  const mockSession: SDKSession = {
    id: 1,
    memory_session_id: 'mem-123',
    project: 'test-project',
    user_prompt: 'Fix the authentication bug in the login module',
    last_assistant_message: 'I have analyzed the authentication flow and found the issue.',
  };

  it('includes user_prompt in the generated prompt', () => {
    const prompt = buildSummaryPrompt(mockSession, mockMode);
    expect(prompt).toContain('USER\'S ORIGINAL REQUEST:');
    expect(prompt).toContain('Fix the authentication bug in the login module');
  });

  it('includes last_assistant_message in the generated prompt', () => {
    const prompt = buildSummaryPrompt(mockSession, mockMode);
    expect(prompt).toContain("Claude's Response:");
    expect(prompt).toContain('I have analyzed the authentication flow and found the issue.');
  });

  it('includes MODE SWITCH header', () => {
    const prompt = buildSummaryPrompt(mockSession, mockMode);
    expect(prompt).toContain('MODE SWITCH: PROGRESS SUMMARY');
  });

  it('instructs to NOT output observation tags', () => {
    const prompt = buildSummaryPrompt(mockSession, mockMode);
    expect(prompt).toContain('Do NOT output <observation> tags');
    expect(prompt).toContain('<summary>');
  });

  it('includes summary XML structure', () => {
    const prompt = buildSummaryPrompt(mockSession, mockMode);
    expect(prompt).toContain('<request>');
    expect(prompt).toContain('<investigated>');
    expect(prompt).toContain('<learned>');
    expect(prompt).toContain('<completed>');
    expect(prompt).toContain('<next_steps>');
    expect(prompt).toContain('<notes>');
  });
});
