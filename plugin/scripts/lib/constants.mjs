// Shared constants for claude-mem hook-perf-patch v2.
// Spec: docs/sprint2/07-tdd-plan-v2.md Phase 0.

export const INTERESTING_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'Skill'];

// Regex form used in hooks.json matcher fields (note: claude-mem default
// hooks.json historically had Bash|Edit|Write|NotebookEdit — Sprint 2 broadens
// this to include MultiEdit, Task, Skill while explicitly excluding Read (noise)
// and mcp__.* (loop risk).
export const INTERESTING_TOOLS_REGEX = INTERESTING_TOOLS.join('|');

export const BACKUP_SUFFIX = '.uds-bak';

export const SESSION_START_MATCHER = 'startup|resume|clear|compact';

// Plugin marker filenames used to identify the cache root
export const PLUGIN_MARKERS = ['scripts/worker-service.cjs', 'scripts/bun-runner.js'];
