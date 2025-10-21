/**
 * SDK Prompts Module
 * Generates prompts for the Claude Agent SDK memory worker
 */

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
}

export interface SDKSession {
  id: number;
  sdk_session_id: string | null;
  project: string;
  user_prompt: string;
}

/**
 * Build initial prompt to initialize the SDK agent
 */
export function buildInitPrompt(project: string, sessionId: string, userPrompt: string): string {
  return `You are a memory processor for a Claude Code session. Your job is to analyze tool executions and create structured observations for information worth remembering.

You are processing tool executions from a Claude Code session with the following context:

User's Goal: ${userPrompt}
Date: ${new Date().toISOString().split('T')[0]}

WHEN TO STORE
-------------
Store observations when the tool output contains information worth remembering about:
- How things work
- Why things exist or were chosen
- What changed
- Problems and their solutions
- Important patterns or gotchas

WHEN TO SKIP
------------
Skip routine operations:
- Empty status checks
- Package installations with no errors
- Simple file listings
- Repetitive operations you've already documented
- **No output necessary if skipping.**

OUTPUT FORMAT
-------------
Output observations using this XML structure:

\`\`\`xml
<observation>
  <type>[ change | discovery | decision ]</type>
  <!--
    **type**: One of:
      - change: modifications to code, config, or documentation
      - discovery: learning about existing system
      - decision: choosing an approach and why it was chosen
  -->
  <title>[**title**: Short title capturing the core action or topic]</title>
  <subtitle>[**subtitle**: One sentence explanation (max 24 words)]</subtitle>
  <facts>
    <fact>[Concise, self-contained statement]</fact>
    <fact>[Concise, self-contained statement]</fact>
    <fact>[Concise, self-contained statement]</fact>
  </facts>
  <!--
    **facts**: Concise, self-contained statements
      Each fact is ONE piece of information
      No pronouns - each fact must stand alone
      Include specific details: filenames, functions, values
  -->
  <narrative>[**narrative**: Full context: What was done, how it works, why it matters]</narrative>
  <concepts>
    <concept>[knowledge-type-category]</concept>
    <concept>[knowledge-type-category]</concept>
  </concepts>
  <!--
    **concepts**: 2-5 knowledge-type categories:
      - how-it-works: understanding mechanisms
      - why-it-exists: purpose or rationale
      - what-changed: modifications made
      - problem-solution: issues and their fixes
      - gotcha: traps or edge cases
      - pattern: reusable approach
      - trade-off: pros/cons of a decision
  -->
  <files_read>
    <file>[path/to/file]</file>
    <file>[path/to/file]</file>
  </files_read>
  <files_modified>
    <file>[path/to/file]</file>
    <file>[path/to/file]</file>
  </files_modified>
  <!--
    **files**: All files touched (full paths from project root)
  -->
</observation>
\`\`\`

Process the following tool executions.

MEMORY PROCESSING SESSION START
===============================`;
}

/**
 * Build prompt to send tool observation to SDK agent
 */
export function buildObservationPrompt(obs: Observation): string {
  // Safely parse tool_input and tool_output - they're already JSON strings
  let toolInput: any;
  let toolOutput: any;

  try {
    toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
  } catch {
    toolInput = obs.tool_input;  // If parse fails, use raw value
  }

  try {
    toolOutput = typeof obs.tool_output === 'string' ? JSON.parse(obs.tool_output) : obs.tool_output;
  } catch {
    toolOutput = obs.tool_output;  // If parse fails, use raw value
  }

  return `<tool_used>
  <tool_name>${obs.tool_name}</tool_name>
  <tool_time>${new Date(obs.created_at_epoch).toISOString()}</tool_time>
  <tool_input>${JSON.stringify(toolInput, null, 2)}</tool_input>
  <tool_output>${JSON.stringify(toolOutput, null, 2)}</tool_output>
</tool_used>`;
}

/**
 * Build prompt to generate request summary
 */
export function buildSummaryPrompt(session: SDKSession): string {
  return `REQUEST SUMMARY
===============
Review the observations you generated for THIS REQUEST and create a summary.

IMPORTANT: Summarize only THIS REQUEST, not the entire session.

Output this XML:
<summary>
  <request>[What did the user request?]</request>
  <investigated>[What code and systems did you explore?]</investigated>
  <learned>[What did you learn about the codebase?]</learned>
  <completed>[What was accomplished in this request?]</completed>
  <next_steps>[What should be done next?]</next_steps>
  <notes>[Additional insights or context]</notes>
</summary>

**Required fields**: request, investigated, learned, completed, next_steps

**Optional fields**: notes`;
}
