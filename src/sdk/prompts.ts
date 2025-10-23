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
  return `You are observing a development session to create searchable memory FOR FUTURE SESSIONS.

CRITICAL: Record what was BUILT/FIXED/DEPLOYED/CONFIGURED, not what you (the observer) are doing.

User's Goal: ${userPrompt}
Date: ${new Date().toISOString().split('T')[0]}

WHAT TO RECORD
--------------
Focus on deliverables and capabilities:
- What the system NOW DOES differently (new capabilities)
- What shipped to users/production (features, fixes, configs, docs)
- Changes in technical domains (auth, data, UI, infra, DevOps, docs)

Use verbs like: implemented, fixed, deployed, configured, migrated, optimized, added, refactored

✅ GOOD EXAMPLES (describes what was built):
- "Authentication now supports OAuth2 with PKCE flow"
- "Deployment pipeline runs canary releases with auto-rollback"
- "Database indexes optimized for common query patterns"

❌ BAD EXAMPLES (describes observation process - DO NOT DO THIS):
- "Analyzed authentication implementation and stored findings"
- "Tracked deployment steps and logged outcomes"
- "Monitored database performance and recorded metrics"

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
  <type>[ bugfix | feature | refactor | change | discovery | decision ]</type>
  <!--
    **type**: MUST be EXACTLY one of these 6 options (no other values allowed):
      - bugfix: something was broken, now fixed
      - feature: new capability or functionality added
      - refactor: code restructured, behavior unchanged
      - change: generic modification (docs, config, misc)
      - discovery: learning about existing system
      - decision: architectural/design choice with rationale
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
    **concepts**: 2-5 knowledge-type categories. MUST use ONLY these exact keywords:
      - how-it-works: understanding mechanisms
      - why-it-exists: purpose or rationale
      - what-changed: modifications made
      - problem-solution: issues and their fixes
      - gotcha: traps or edge cases
      - pattern: reusable approach
      - trade-off: pros/cons of a decision

    IMPORTANT: Do NOT include the observation type (change/discovery/decision) as a concept.
    Types and concepts are separate dimensions.
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
  return `THIS REQUEST'S SUMMARY
===============
Think about the observations you just wrote for this request, and write a summary of what was done, what was learned, and what's next.

IMPORTANT! DO NOT summarize the observation process itself - you are summarizing a DIFFERENT claude code session, not this one.

User's Original Request: ${session.user_prompt}

WHEN NOT TO SUMMARIZE
----------------------
Do not summarize if the request is conversational and unrelated to the work that was just completed.

If skipping, **output only**: <skip_summary reason="[brief reason]" />

✅ GOOD - Describes deliverables:
<request>Fix authentication timeout bug</request>
<request>Add three-tier verbosity system to session summaries</request>
<request>Deploy Kubernetes cluster with auto-scaling</request>

❌ BAD - Describes meta-operations (DO NOT DO THIS):
<request>Process tool executions and store observations</request>
<request>Analyze session data and generate summaries</request>
<request>Track file modifications across sessions</request>

Output this XML:
<summary>
  <request>[What did the user request? Use their original sentiment from: ${session.user_prompt}]</request>
  <investigated>[What was explored?]</investigated>
  <learned>[What was discovered about how things work?]</learned>
  <completed>[What shipped? What does the system now do?]</completed>
  <next_steps>[What are the next steps?]</next_steps>
  <notes>[Additional insights]</notes>
</summary>

**Required fields**: request, investigated, learned, completed, next_steps
**Optional fields**: notes`;
}
