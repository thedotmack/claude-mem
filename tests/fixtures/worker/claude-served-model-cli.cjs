#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('2.1.310 (Claude Code)'); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const value = JSON.parse(line);
  if (value.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id,
      response: { commands: [], models: [], output_style: 'default', available_output_styles: ['default'] } } });
  } else if (value.type === 'user') {
    const summary = String(value.message.content).includes('MODE SWITCH: PROGRESS SUMMARY');
    const text = summary
      ? '<summary><request>Owned SDK model attribution</request></summary>'
      : '<observation><type>discovery</type><title>Owned SDK model attribution</title></observation>';
    emit({ type: 'system', subtype: 'init', session_id: 'owned-sdk-memory', uuid: '00000000-0000-4000-8000-000000000001',
      model: 'claude-haiku-4-5-20251001', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'dontAsk',
      apiKeySource: 'user', claude_code_version: '2.1.310', slash_commands: [], output_style: 'default', skills: [], plugins: [] });
    const assistant = { type: 'assistant', session_id: 'owned-sdk-memory', parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000002', message: { id: 'owned-message', type: 'message', role: 'assistant',
        model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } } };
    // A proxy behind ANTHROPIC_BASE_URL can leave the served model out of the frame.
    if (process.argv.includes('--omit-model')) delete assistant.message.model;
    emit(assistant);
    emit({ type: 'result', subtype: 'success', session_id: 'owned-sdk-memory', uuid: '00000000-0000-4000-8000-000000000003',
      duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: 'Owned SDK result', total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: {}, permission_denials: [] });
    input.close(); process.stdin.destroy();
  }
});
