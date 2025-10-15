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
  return `You are a memory assistant for the "${project}" project.

SESSION CONTEXT
---------------
Session ID: ${sessionId}
User's Goal: ${userPrompt}
Date: ${new Date().toISOString().split('T')[0]}

YOUR ROLE
---------
You will observe tool executions during this Claude Code session. Your job is to:

1. Extract meaningful insights (not just raw data)
2. Store atomic observations in SQLite
3. Focus on: key decisions, patterns discovered, problems solved, technical insights

WHAT TO CAPTURE
----------------
✓ Architecture decisions (e.g., "chose PostgreSQL over MongoDB for ACID guarantees")
✓ Bug fixes (e.g., "fixed race condition in auth middleware by adding mutex")
✓ New features (e.g., "implemented JWT refresh token flow")
✓ Refactorings (e.g., "extracted validation logic into separate service")
✓ Discoveries (e.g., "found that API rate limit is 100 req/min")

✗ NOT routine operations (reading files, listing directories)
✗ NOT work-in-progress (only completed work)
✗ NOT obvious facts (e.g., "TypeScript file has types")

HOW TO STORE OBSERVATIONS
--------------------------
When you identify something worth remembering, output your observation in this EXACT XML format:

\`\`\`xml
<observation>
  <type>feature</type>
  <text>Implemented JWT token refresh flow with 7-day expiry</text>
</observation>
\`\`\`

Valid types: decision, bugfix, feature, refactor, discovery

Structure requirements:
- <observation> is the root element
- <type> must be one of the 5 valid types (single word)
- <text> contains your concise observation (one sentence preferred)
- No additional fields or nesting

The SDK worker will parse all <observation> blocks from your response using regex and store them in SQLite.

You can include your reasoning before or after the observation block, or just output the observation by itself.

EXAMPLE
-------
Bad: "Read src/auth.ts file"
Good: "Implemented JWT token refresh flow with 7-day expiry"

Wait for tool observations. Acknowledge this message briefly.`;
}

/**
 * Build prompt to send tool observation to SDK agent
 */
export function buildObservationPrompt(obs: Observation): string {
  return `TOOL OBSERVATION
================
Tool: ${obs.tool_name}
Time: ${new Date(obs.created_at_epoch).toISOString()}

Input:
${JSON.stringify(JSON.parse(obs.tool_input), null, 2)}

Output:
${JSON.stringify(JSON.parse(obs.tool_output), null, 2)}

ANALYSIS TASK
-------------
1. Does this observation contain something worth remembering?
2. If YES: Output the observation in this EXACT XML format:

   \`\`\`xml
   <observation>
     <type>feature</type>
     <text>Your concise observation here</text>
   </observation>
   \`\`\`

   Requirements:
   - Use one of these types: decision, bugfix, feature, refactor, discovery
   - Keep text concise (one sentence preferred)
   - No markdown formatting inside <text>
   - No additional XML fields

3. If NO: Just acknowledge and wait for next observation

Remember: Quality over quantity. Only store meaningful insights.`;
}

/**
 * Build finalization prompt to generate session summary
 */
export function buildFinalizePrompt(session: SDKSession): string {
  return `SESSION ENDING
==============
The Claude Code session is finishing.

FINAL TASK
----------
1. Review the observations you've stored this session
2. Generate a structured summary that answers these questions:
   - What did user request?
   - What did you investigate?
   - What did you learn?
   - What did you do?
   - What's next?
   - Files read
   - Files edited
   - Notes

3. Generate the structured summary and output it in this EXACT XML format:

\`\`\`xml
<summary>
  <request>Implement JWT authentication system</request>
  <investigated>Existing auth middleware, session management, token storage patterns</investigated>
  <learned>Current system uses session cookies; no JWT support; race condition in middleware</learned>
  <completed>Implemented JWT token + refresh flow with 7-day expiry; fixed race condition with mutex; added token validation middleware</completed>
  <next_steps>Add token revocation API endpoint; write integration tests</next_steps>
  <files_read>
    <file>src/auth.ts</file>
    <file>src/middleware/session.ts</file>
    <file>src/types/user.ts</file>
  </files_read>
  <files_edited>
    <file>src/auth.ts</file>
    <file>src/middleware/auth.ts</file>
    <file>src/routes/auth.ts</file>
  </files_edited>
  <notes>Token secret stored in .env; refresh tokens use rotation strategy</notes>
</summary>
\`\`\`

Structure requirements:
- <summary> is the root element
- All 8 child elements are REQUIRED: request, investigated, learned, completed, next_steps, files_read, files_edited, notes
- <files_read> and <files_edited> must contain <file> child elements (one per file)
- If no files were read/edited, use empty tags: <files_read></files_read>
- Text fields can be multiple sentences but avoid markdown formatting
- Use underscores in element names: next_steps, files_read, files_edited

The SDK worker will parse the <summary> block and extract all fields to store in SQLite.

Generate the summary now in the required XML format.`;
}
