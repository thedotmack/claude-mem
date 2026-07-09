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

    expect(prompt).toContain('Return either one or more <observation>...</observation> blocks, or an empty response');
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
