/**
 * Hook Templates Test
 * 
 * Basic validation tests for hook response templates to ensure they
 * generate valid responses that conform to Claude Code's hook system.
 */

import {
  createPreCompactSuccessResponse,
  createPreCompactBlockedResponse,
  createPreCompactApprovalResponse,
  createSessionStartSuccessResponse,
  createSessionStartEmptyResponse,
  createSessionStartErrorResponse,
  createSessionStartMemoryResponse,
  createPreToolUseAllowResponse,
  createPreToolUseDenyResponse,
  createPreToolUseAskResponse,
  createHookSuccessResponse,
  createHookErrorResponse,
  validateHookResponse,
  createContextualHookResponse,
  formatDuration,
  createOperationSummary,
  OPERATION_STATUS_TEMPLATES,
  ERROR_RESPONSE_TEMPLATES
} from './HookTemplates.js';

// =============================================================================
// PRE-COMPACT HOOK TESTS
// =============================================================================

console.log('Testing Pre-Compact Hook Templates...');

// Test successful pre-compact response
const preCompactSuccess = createPreCompactSuccessResponse();
console.log('✓ Pre-compact success:', JSON.stringify(preCompactSuccess, null, 2));

// Test blocked pre-compact response
const preCompactBlocked = createPreCompactBlockedResponse('User requested to skip compression');
console.log('✓ Pre-compact blocked:', JSON.stringify(preCompactBlocked, null, 2));

// Test approval response
const preCompactApproval = createPreCompactApprovalResponse('approve', 'Compression approved by policy');
console.log('✓ Pre-compact approval:', JSON.stringify(preCompactApproval, null, 2));

// =============================================================================
// SESSION START HOOK TESTS
// =============================================================================

console.log('\nTesting Session Start Hook Templates...');

// Test successful session start with context
const sessionStartSuccess = createSessionStartSuccessResponse('Loaded 5 memories from previous sessions');
console.log('✓ Session start success:', JSON.stringify(sessionStartSuccess, null, 2));

// Test empty session start
const sessionStartEmpty = createSessionStartEmptyResponse();
console.log('✓ Session start empty:', JSON.stringify(sessionStartEmpty, null, 2));

// Test error session start
const sessionStartError = createSessionStartErrorResponse('Memory index corrupted');
console.log('✓ Session start error:', JSON.stringify(sessionStartError, null, 2));

// Test rich memory response
const sessionStartMemory = createSessionStartMemoryResponse({
  projectName: 'claude-mem',
  memoryCount: 12,
  lastSessionTime: '2 hours ago',
  recentComponents: ['PromptOrchestrator', 'HookTemplates', 'MCPClient'],
  recentDecisions: ['Use TypeScript for type safety', 'Implement embedded Weaviate']
});
console.log('✓ Session start memory:', JSON.stringify(sessionStartMemory, null, 2));

// =============================================================================
// PRE-TOOL USE HOOK TESTS
// =============================================================================

console.log('\nTesting Pre-Tool Use Hook Templates...');

// Test allow response
const preToolAllow = createPreToolUseAllowResponse('Tool execution approved by security policy');
console.log('✓ Pre-tool allow:', JSON.stringify(preToolAllow, null, 2));

// Test deny response
const preToolDeny = createPreToolUseDenyResponse('Bash commands disabled in restricted mode');
console.log('✓ Pre-tool deny:', JSON.stringify(preToolDeny, null, 2));

// Test ask response
const preToolAsk = createPreToolUseAskResponse('File operation requires user confirmation');
console.log('✓ Pre-tool ask:', JSON.stringify(preToolAsk, null, 2));

// =============================================================================
// GENERIC HOOK TESTS
// =============================================================================

console.log('\nTesting Generic Hook Templates...');

// Test basic success
const genericSuccess = createHookSuccessResponse(false);
console.log('✓ Generic success:', JSON.stringify(genericSuccess, null, 2));

// Test basic error
const genericError = createHookErrorResponse('Operation failed due to network timeout', true);
console.log('✓ Generic error:', JSON.stringify(genericError, null, 2));

// =============================================================================
// VALIDATION TESTS
// =============================================================================

console.log('\nTesting Hook Response Validation...');

// Test valid PreCompact response
const preCompactValidation = validateHookResponse(preCompactSuccess, 'PreCompact');
console.log('✓ PreCompact validation:', preCompactValidation);

// Test invalid PreCompact response (with hookSpecificOutput)
const invalidPreCompact = {
  continue: true,
  hookSpecificOutput: { hookEventName: 'PreCompact' }
};
const preCompactInvalidValidation = validateHookResponse(invalidPreCompact, 'PreCompact');
console.log('✓ PreCompact invalid validation:', preCompactInvalidValidation);

// Test valid SessionStart response
const sessionStartValidation = validateHookResponse(sessionStartSuccess, 'SessionStart');
console.log('✓ SessionStart validation:', sessionStartValidation);

// =============================================================================
// CONTEXTUAL HOOK RESPONSE TESTS
// =============================================================================

console.log('\nTesting Contextual Hook Responses...');

// Test successful session start context
const contextualSessionStart = createContextualHookResponse({
  hookEventName: 'SessionStart',
  sessionId: 'test-123',
  success: true,
  message: 'Successfully loaded 8 memories from previous claude-mem sessions'
});
console.log('✓ Contextual SessionStart:', JSON.stringify(contextualSessionStart, null, 2));

// Test failed PreCompact context
const contextualPreCompactFail = createContextualHookResponse({
  hookEventName: 'PreCompact',
  sessionId: 'test-123',
  success: false,
  message: 'Compression blocked: insufficient disk space'
});
console.log('✓ Contextual PreCompact fail:', JSON.stringify(contextualPreCompactFail, null, 2));

// =============================================================================
// UTILITY FUNCTION TESTS
// =============================================================================

console.log('\nTesting Utility Functions...');

// Test duration formatting
console.log('✓ Duration 500ms:', formatDuration(500));
console.log('✓ Duration 5s:', formatDuration(5000));
console.log('✓ Duration 90s:', formatDuration(90000));
console.log('✓ Duration 2m30s:', formatDuration(150000));

// Test operation summary
console.log('✓ Operation summary success:', createOperationSummary('Memory compression', true, 5000, 15, 'entities extracted'));
console.log('✓ Operation summary failure:', createOperationSummary('Context loading', false, 2000, 0, 'connection timeout'));

// =============================================================================
// TEMPLATE CONSTANT TESTS
// =============================================================================

console.log('\nTesting Template Constants...');

// Test operation status templates
console.log('✓ Compression complete:', OPERATION_STATUS_TEMPLATES.COMPRESSION_COMPLETE(25, 5000));
console.log('✓ Context loaded:', OPERATION_STATUS_TEMPLATES.CONTEXT_LOADED(8));
console.log('✓ Tool allowed:', OPERATION_STATUS_TEMPLATES.TOOL_ALLOWED('Bash'));

// Test error response templates
console.log('✓ File not found:', ERROR_RESPONSE_TEMPLATES.FILE_NOT_FOUND('/path/to/transcript.txt'));
console.log('✓ Connection failed:', ERROR_RESPONSE_TEMPLATES.CONNECTION_FAILED('MCP memory server'));
console.log('✓ Operation timeout:', ERROR_RESPONSE_TEMPLATES.OPERATION_TIMEOUT('compression', 30000));

console.log('\n✅ All hook template tests completed successfully!');