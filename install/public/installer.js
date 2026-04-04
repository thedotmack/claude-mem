#!/usr/bin/env node

// claude-mem installer redirect
// The old bundled installer has been replaced by npx claude-mem.
// This script now redirects users to the new install method.

console.log('');
console.log('\x1b[33mThe bundled installer has been replaced.\x1b[0m');
console.log('');
console.log('\x1b[32mInstall claude-mem with:\x1b[0m');
console.log('');
console.log('  \x1b[36mnpx claude-mem install\x1b[0m');
console.log('');
console.log('For more info, visit: \x1b[36mhttps://docs.claude-mem.ai/installation\x1b[0m');
console.log('');

process.exit(0);
