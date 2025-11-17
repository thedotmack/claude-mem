import { silentDebug } from './src/utils/silent-debug.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

console.log('Testing silentDebug utility...\n');

// Test 1: Basic message with fallback
console.log('Test 1: Basic message with fallback');
const result = silentDebug('Test error occurred', { errorCode: 404, path: '/api/test' }, 'default-value');
console.log('  Returned:', result);
console.log('  Expected: default-value');
console.log('  ✓ Pass\n');

// Test 2: Message without fallback
console.log('Test 2: Message without fallback (empty string default)');
const result2 = silentDebug('Another test error', { type: 'warning' });
console.log('  Returned:', JSON.stringify(result2));
console.log('  Expected: ""');
console.log('  ✓ Pass\n');

// Test 3: Verify log file exists
console.log('Test 3: Verify log file creation');
const logFile = join(homedir(), '.claude-mem', 'silent.log');
if (existsSync(logFile)) {
  console.log('  ✓ Log file exists at:', logFile);
} else {
  console.log('  ✗ Log file does NOT exist at:', logFile);
}

console.log('\n✅ Manual test completed!');
console.log('\nTo view the log file:');
console.log('  cat ~/.claude-mem/silent.log');
console.log('  npm run logs:silent');
