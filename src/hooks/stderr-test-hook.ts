/**
 * Test hook to verify if stderr messages appear in Claude Code UI
 * This hook simply outputs a message via console.error()
 */

// Output a test message to stderr
console.error('🧪 TEST: This is a stderr message from the claude-mem hook');

// Exit successfully
process.exit(0);
