/**
 * SDK Prompts Module
 * Generates prompts for the Claude Agent SDK memory worker
 */

import { silentDebug } from '../utils/silent-debug.js';

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
}

export interface SDKSession {
  id: number;
  sdk_session_id: string | null;
  project: string;
  user_prompt: string;
  last_user_message?: string;
}

/**
 * Build initial prompt to initialize the SDK agent
 */
export function buildInitPrompt(project: string, sessionId: string, userPrompt: string): string {
  return `You are a Claude-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.

CRITICAL: Record what was LEARNED/BUILT/FIXED/DEPLOYED/CONFIGURED, not what you (the observer) are doing.

User's Goal: ${userPrompt}
Date: ${new Date().toISOString().split('T')[0]}

Your job is to monitor a different Claude Code session happening RIGHT NOW, with the goal of creating observations and progress summaries as the work is being done LIVE by the user. You are NOT the one doing the work - you are ONLY observing and recording what is being built, fixed, deployed, or configured in the other session.

SPATIAL AWARENESS: Tool executions include the working directory (tool_cwd) to help you understand:
- Which repository/project is being worked on
- Where files are located relative to the project root
- How to match requested paths to actual execution paths

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
- If file related research comes back as empty or not found
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

IMPORTANT! DO NOT do any work other than generate the OBSERVATIONS or PROGRESS SUMMARIES - and remember that you are a memory agent designed to summarize a DIFFERENT claude code session, not this one. Never reference yourself or your own actions. Never output anything other than the XML structures defined for observations and summaries. All other output is ignored and would be better left unsaid.

MEMORY PROCESSING START
=======================`;
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
  <tool_time>${new Date(obs.created_at_epoch).toISOString()}</tool_time>${obs.cwd ? `\n  <tool_cwd>${obs.cwd}</tool_cwd>` : ''}
  <tool_input>${JSON.stringify(toolInput, null, 2)}</tool_input>
  <tool_output>${JSON.stringify(toolOutput, null, 2)}</tool_output>
</tool_used>`;
}

/**
 * Build prompt to generate progress summary
 */
export function buildSummaryPrompt(session: SDKSession): string {
  const lastUserMessage = session.last_user_message || silentDebug('session.last_user_message missing', { session });

  return `PROGRESS SUMMARY CHECKPOINT
===========================
Write progress notes of what was done, what was learned, and what's next. This is a checkpoint to capture progress so far. The session is ongoing - you may receive more requests and tool executions after this summary. Write "next_steps" as the current trajectory of work (what's actively being worked on or coming up next), not as post-session future work. Always write at least a minimal summary explaining current progress, even if work is still in early stages, so that users see a summary output tied to each request.

Last User Message:
${lastUserMessage}

Respond in this XML format:
<summary>
  <request>[Short title related to the last user message above]</request>
  <investigated>[What has been explored so far? What was examined?]</investigated>
  <learned>[What have you learned about how things work?]</learned>
  <completed>[What work has been completed so far? What has shipped or changed?]</completed>
  <next_steps>[What are you actively working on or planning to work on next in this session?]</next_steps>
  <notes>[Additional insights or observations about the current progress]</notes>
</summary>

IMPORTANT! DO NOT do any work other than generate the PROGRESS SUMMARY  - and remember that you are a memory agent designed to summarize a DIFFERENT claude code session, not this one. Never reference yourself or your own actions. Never output anything other than the XML structures defined for observations and summaries. All other output is ignored and would be better left unsaid.`;
}

/**
 * Build prompt for continuation of existing session
 *
 * CRITICAL: Why claudeSessionId Parameter is Required
 * ====================================================
 * This function receives claudeSessionId from SDKAgent.ts, which comes from:
 * - SessionManager.initializeSession (fetched from database)
 * - SessionStore.createSDKSession (stored by new-hook.ts)
 * - new-hook.ts receives it from Claude Code's hook context
 *
 * The claudeSessionId is the SAME session_id used by:
 * - NEW hook (to create/fetch session)
 * - SAVE hook (to store observations)
 * - This continuation prompt (to maintain session context)
 *
 * This is how everything stays connected - ONE session_id threading through
 * all hooks and prompts in the same conversation.
 *
 * Called when: promptNumber > 1 (see SDKAgent.ts line 150)
 * First prompt: Uses buildInitPrompt instead (promptNumber === 1)
 */
export function buildContinuationPrompt(userPrompt: string, promptNumber: number, claudeSessionId: string): string {
  return `This is continuation prompt #${promptNumber} for session ${claudeSessionId} that you're observing.

CRITICAL: Record what was LEARNED/BUILT/FIXED/DEPLOYED/CONFIGURED, not what you (the observer) are doing.

User's Goal: ${userPrompt}
Date: ${new Date().toISOString().split('T')[0]}

Your job is to continue monitoring the different Claude Code session happening RIGHT NOW, with the goal of creating observations and a progress summary as the work is being done LIVE by the user. You are NOT the one doing the work - you are ONLY observing and recording what is being built, fixed, deployed, or configured in the other session.

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
- If file related research comes back as empty or not found
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

IMPORTANT! DO NOT do any work other than generate the OBSERVATIONS or PROGRESS SUMMARIES - and remember that you are a memory agent designed to summarize a DIFFERENT claude code session, not this one. Never reference yourself or your own actions. Never output anything other than the XML structures defined for observations and summaries. All other output is ignored and would be better left unsaid.

MEMORY PROCESSING START
=======================`;

}

/**
 * Build prompt for intelligent context selection
 *
 * This implements the workflow from docs/context/real-time-context-workflow.md:
 * 1. Think about questions needed to answer the request
 * 2. Check session start observations first
 * 3. Search if needed
 * 4. Return specific observation IDs
 */
export function buildContextSelectionPrompt(
  userPrompt: string,
  sessionStartObservations: Array<{ id: number; title: string; subtitle: string; type: string }>,
  project: string
): string {
  const obsTable = sessionStartObservations.length > 0
    ? sessionStartObservations.map(o => `  - [${o.id}] (${o.type}) ${o.title}: ${o.subtitle}`).join('\n')
    : '  (No observations available from session start)';

  return `You are helping select relevant context for a user's request in a Claude Code session.

PROJECT: ${project}
DATE: ${new Date().toISOString().split('T')[0]}

USER REQUEST:
${userPrompt}

WORKFLOW:
1. Think about all the questions you might need answered to complete this request successfully
2. Review the session start observations below
3. Would any of these observations contain answers to your questions?
4. If yes, list those observation IDs
5. If no, you'll need to search for more context

SESSION START OBSERVATIONS:
${obsTable}

TASK:
Analyze the user's request and the available observations. Return a JSON response with:

{
  "questions": ["question 1", "question 2", ...],
  "relevant_session_start_ids": [id1, id2, ...],
  "needs_search": true/false,
  "search_query": "optional search query if needs_search is true"
}

IMPORTANT:
- Only include observation IDs that ACTUALLY help answer the user's request
- If session start observations are sufficient, set needs_search to false
- If you need more context, set needs_search to true and provide a search query
- Return ONLY the JSON object, nothing else`;
}