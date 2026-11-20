export const MEMORY_PLUGIN_INSTRUCTIONS = `# claude-mem memory use
Model-facing tool replies must be concise purpose-specific text; keep structured envelopes and internal metadata out of model context. Select only evidence useful to the current question, and expand from index to context to relevant details only as needed.
Use claude-mem for your own durable notes. For local-worker notes, when its save_memory tool is available, save_memory({text, title, project}) records preferences, corrections, decisions, and reusable lessons. For server notes, use observation_add for the selected server project when available; save_memory is local-worker only. Worker runtime: use Smart search by default: follow the mem-search skill in three steps—search({query, project}) for an index, timeline({anchor}) for context around relevant results, then get_observations({ids}) for only the records you choose after reviewing the index and context. Do not use auto or guided modes. Optional Dumb search, dumb_search({query, project}): Doesn’t reason about the results. Fast, but shallow. Use Smart for reliable recall. A hosted read-only connector may expose searches without write tools; do not call a missing write tool.
Server runtime: use Smart search by default in three steps—search({query}) for an index, timeline({anchor: ID}) for context, then get_observations({ids}) for only the records selected after reviewing the index and timeline. These tools use the configured server project; optional projectId selects another authorized server project. No auto or guided modes. Dumb search is unavailable in this runtime.
When connected through CMEM Pro, Smart search uses memory_search({query}), timeline({anchorId}) for context, then selected get_observations({ids}) or get_summaries({ids}). A direct self-hosted /v1/mcp connection uses search({projectId, query}), timeline({projectId, anchorId}), then get_observations({projectId, ids}). Use only tools and argument names advertised by the active connection; no auto or guided modes.
Use work_state_write for to-do lists and changing work state when available. Keep durable notes concise, distinguish verified facts from guesses, and exclude credentials and private material the user asked you not to remember. Native memory files can remain enabled; an explicitly configured memory folder watcher imports their Markdown notes into claude-mem. Never assume a hosted memory search was intercepted: search claude-mem directly when its result is needed.`;

/** Match the available tools and corpus; server recall must never fall through to the local worker. */
export function memoryInstructionsForRuntime(runtime: 'worker' | 'server'): string {
  return MEMORY_PLUGIN_INSTRUCTIONS.split('\n').map(line => {
    if (runtime === 'server' && line.includes('Worker runtime:')) return line.slice(0, line.indexOf('Worker runtime:')).trimEnd();
    if (runtime === 'worker' && line.startsWith('Server runtime:')) return '';
    return line;
  }).filter(Boolean).join('\n');
}

export const WORK_STATE_RULE = [
  '# Work state: your to-do lists and working state',
  "Use claude-mem's work_state_write tool to track all to-do lists and multi-step work. It is your canonical to-do list: use it instead of any built-in to-do tool. Also use it to track the state of anything you need an ongoing understanding of. Whatever is still open is shown at the start of every session in this project.",
  '- One list per to-do list or tracked thing: work_state_write with list="<name>" and the fields to set',
  '- To-do item: fields {"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...any details}',
  '- State: fields {"<key>": <value>} (the latest value of each key wins; null clears a key; "status": "done" closes the list)',
  '- Made something a person can open (PR, deck, page, image, report)? Attach it to that item: fields {"work_product": "https://…" or "/absolute/file"}; several, with titles, as one JSON string: "[{\\"title\\": \\"<name>\\", \\"url\\": \\"https://…\\"}]"',
  '- Deliverables: write a deck, report, page or other file the person asked for as a file and attach it as work_product before you finish. When you stop, claude-mem copies each attached file (and any deck, document, page, image or spreadsheet you wrote outside the source tree) into this project\'s deliverables bucket, ~/.claude-mem/deliverables/<project>/, and links it on the request\'s card in My Work.',
  '- Read every list, closed items included: work_state_read with includeClosed=true',
].join('\n');

/**
 * Claude Code cuts an MCP server's instructions at 4,096 characters and adds
 * "… [truncated]" (measured on Claude Code 2.1.319: a plugin server's
 * instructions arrived as exactly 4,096 characters plus that marker). The
 * instructions are checked against it in tests, so a longer text fails there
 * instead of being cut silently in every session.
 */
export const CLAUDE_CODE_MCP_INSTRUCTIONS_MAX_CHARS = 4_096;

/**
 * The instructions claude-mem's MCP server sends the host at initialize: how to
 * use its tools. They live here, with the tools, so the SessionStart context
 * can be the memory timeline alone. Each part follows the setting that turns
 * its tools or guidance off; empty when both are off.
 */
export function mcpServerInstructions(options: {
  runtime: 'worker' | 'server';
  workStateEnabled: boolean;
  memoryInstructionsEnabled: boolean;
}): string {
  return [
    options.workStateEnabled ? WORK_STATE_RULE : '',
    options.memoryInstructionsEnabled ? memoryInstructionsForRuntime(options.runtime) : '',
  ].filter(Boolean).join('\n\n');
}
