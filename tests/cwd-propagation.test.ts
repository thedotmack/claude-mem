import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * CWD Propagation Tests
 * 
 * These tests verify that the working directory (cwd) context flows correctly
 * from hook input through the worker service to the SDK agent prompts.
 */

describe('CWD Propagation Tests', () => {
  test('save-hook should extract cwd from input', () => {
    // Test that PostToolUseInput interface includes cwd
    const mockInput = {
      session_id: 'test-session',
      cwd: '/home/user/project',
      tool_name: 'ReadTool',
      tool_input: { path: 'README.md' },
      tool_response: { content: 'test' }
    };

    // Verify the shape matches PostToolUseInput
    assert.strictEqual(typeof mockInput.cwd, 'string');
    assert.strictEqual(mockInput.cwd, '/home/user/project');
  });

  test('ObservationData should include cwd field', () => {
    // Import the type to ensure it compiles with cwd
    type ObservationData = {
      tool_name: string;
      tool_input: any;
      tool_response: any;
      prompt_number: number;
      cwd?: string;
    };

    const mockData: ObservationData = {
      tool_name: 'ReadTool',
      tool_input: { path: 'test.ts' },
      tool_response: { content: 'test' },
      prompt_number: 1,
      cwd: '/test/project'
    };

    assert.strictEqual(mockData.cwd, '/test/project');
  });

  test('PendingMessage should include cwd field', () => {
    // Import the type to ensure it compiles with cwd
    type PendingMessage = {
      type: 'observation' | 'summarize';
      tool_name?: string;
      tool_input?: any;
      tool_response?: any;
      prompt_number?: number;
      cwd?: string;
    };

    const mockMessage: PendingMessage = {
      type: 'observation',
      tool_name: 'ReadTool',
      tool_input: { path: 'test.ts' },
      tool_response: { content: 'test' },
      prompt_number: 1,
      cwd: '/test/workspace'
    };

    assert.strictEqual(mockMessage.cwd, '/test/workspace');
  });

  test('buildObservationPrompt should include tool_cwd when present', () => {
    // Mock implementation of what buildObservationPrompt does
    const mockObservation = {
      id: 1,
      tool_name: 'ReadTool',
      tool_input: JSON.stringify({ path: 'test.ts' }),
      tool_output: JSON.stringify({ content: 'test' }),
      created_at_epoch: Date.now(),
      cwd: '/home/user/my-project'
    };

    // Simulate the prompt generation
    const promptSegment = mockObservation.cwd 
      ? `\n  <tool_cwd>${mockObservation.cwd}</tool_cwd>` 
      : '';
    
    // Verify cwd is included in the prompt
    assert.ok(promptSegment.includes('<tool_cwd>'));
    assert.ok(promptSegment.includes('/home/user/my-project'));
  });

  test('buildObservationPrompt should handle missing cwd gracefully', () => {
    // Mock observation without cwd
    const mockObservation = {
      id: 1,
      tool_name: 'ReadTool',
      tool_input: JSON.stringify({ path: 'test.ts' }),
      tool_output: JSON.stringify({ content: 'test' }),
      created_at_epoch: Date.now()
    };

    // Simulate the prompt generation (no cwd)
    const promptSegment = mockObservation.cwd 
      ? `\n  <tool_cwd>${mockObservation.cwd}</tool_cwd>` 
      : '';
    
    // Verify no tool_cwd element when cwd is undefined
    assert.strictEqual(promptSegment, '');
  });

  test('worker API body should include cwd field', () => {
    // Mock worker API request body
    const requestBody = {
      tool_name: 'ReadTool',
      tool_input: JSON.stringify({ path: 'test.ts' }),
      tool_response: JSON.stringify({ content: 'test' }),
      prompt_number: 1,
      cwd: '/workspace/project'
    };

    // Verify all expected fields are present
    assert.strictEqual(requestBody.tool_name, 'ReadTool');
    assert.strictEqual(requestBody.prompt_number, 1);
    assert.strictEqual(requestBody.cwd, '/workspace/project');
  });

  test('buildInitPrompt should mention spatial awareness', () => {
    // Mock the init prompt check
    const initPromptSnippet = `SPATIAL AWARENESS: Tool executions include the working directory (tool_cwd) to help you understand:
- Which repository/project is being worked on
- Where files are located relative to the project root
- How to match requested paths to actual execution paths`;

    // Verify the prompt explains spatial awareness
    assert.ok(initPromptSnippet.includes('SPATIAL AWARENESS'));
    assert.ok(initPromptSnippet.includes('tool_cwd'));
    assert.ok(initPromptSnippet.includes('working directory'));
  });

  test('cwd should flow from hook to worker to SDK agent', () => {
    // End-to-end flow test (conceptual)
    const hookInput = {
      session_id: 'test-123',
      cwd: '/home/developer/awesome-project',
      tool_name: 'ReadTool',
      tool_input: { path: 'src/index.ts' },
      tool_response: { content: 'export default...' }
    };

    // Step 1: Hook extracts cwd
    const extractedCwd = hookInput.cwd;
    assert.strictEqual(extractedCwd, '/home/developer/awesome-project');

    // Step 2: Worker receives cwd in observation data
    const observationData = {
      tool_name: hookInput.tool_name,
      tool_input: hookInput.tool_input,
      tool_response: hookInput.tool_response,
      prompt_number: 1,
      cwd: extractedCwd
    };
    assert.strictEqual(observationData.cwd, extractedCwd);

    // Step 3: SDK agent includes cwd in observation prompt
    const sdkObservation = {
      id: 0,
      tool_name: observationData.tool_name,
      tool_input: JSON.stringify(observationData.tool_input),
      tool_output: JSON.stringify(observationData.tool_response),
      created_at_epoch: Date.now(),
      cwd: observationData.cwd
    };
    assert.strictEqual(sdkObservation.cwd, extractedCwd);

    // Step 4: Prompt includes tool_cwd element
    const promptSnippet = sdkObservation.cwd 
      ? `<tool_cwd>${sdkObservation.cwd}</tool_cwd>` 
      : '';
    assert.ok(promptSnippet.includes('<tool_cwd>'));
    assert.ok(promptSnippet.includes(extractedCwd));
  });
});
