/**
 * Analysis Templates for LLM Instructions
 * 
 * Generates prompts for extracting memories from conversations and storing in Chroma
 */

import Handlebars from 'handlebars';

// =============================================================================
// MAIN ANALYSIS PROMPT TEMPLATE
// =============================================================================

const ANALYSIS_PROMPT = `You are analyzing a Claude Code conversation transcript to create memories using the Chroma MCP memory system.

YOUR TASK:
1. Extract key learnings and accomplishments as natural language memories
2. Store memories using mcp__claude-mem__chroma_add_documents
3. Return a structured JSON response with the extracted summaries

WHAT TO EXTRACT:
- Technical implementations (functions, classes, APIs, databases)
- Design patterns and architectural decisions
- Bug fixes and problem solutions
- Workflows, processes, and integrations
- Performance optimizations and improvements

STORAGE INSTRUCTIONS:
Call mcp__claude-mem__chroma_add_documents with:
- collection_name: "claude_memories"
- documents: Array of natural language descriptions
- ids: ["{{projectPrefix}}_{{sessionId}}_1", "{{projectPrefix}}_{{sessionId}}_2", ...]
- metadatas: Array with fields:
  * type: component/pattern/workflow/integration/concept/decision/tool/fix
  * keywords: Comma-separated search terms
  * context: Brief situation description
  * timestamp: "{{timestamp}}"
  * session_id: "{{sessionId}}"

ERROR HANDLING:
If you get "IDs already exist" errors, use mcp__claude-mem__chroma_update_documents instead.
If any tool calls fail, continue and return the JSON response anyway.

Project: {{projectPrefix}}
Session ID: {{sessionId}}

Conversation to compress:`;

// Compile template once
const compiledAnalysisPrompt = Handlebars.compile(ANALYSIS_PROMPT, { noEscape: true });

// =============================================================================
// MAIN API FUNCTIONS
// =============================================================================

/**
 * Creates the comprehensive analysis prompt for memory extraction
 */
export function buildComprehensiveAnalysisPrompt(
  projectPrefix: string,
  sessionId: string,
  timestamp?: string,
  archiveFilename?: string
): string {
  const context = {
    projectPrefix,
    sessionId,
    timestamp: timestamp || new Date().toISOString(),
    archiveFilename: archiveFilename || `${sessionId}.jsonl.archive`
  };

  return compiledAnalysisPrompt(context);
}

/**
 * Creates the analysis prompt
 */
export function createAnalysisPrompt(
  transcript: string,
  sessionId: string,
  projectPrefix: string,
  timestamp?: string
): string {
  const prompt = buildComprehensiveAnalysisPrompt(
    projectPrefix,
    sessionId,
    timestamp
  );
  
  const responseFormat = `

RESPONSE FORMAT:
After storing memories in Chroma, return EXACTLY this JSON structure wrapped in tags:

<JSONResponse>
{
  "overview": "2-3 sentence summary of session themes and accomplishments. Write for any developer to understand by organically defining jargon.",
  "summaries": [
    {
      "text": "What was accomplished (start with action verb)",
      "document_id": "${projectPrefix}_${sessionId}_1",
      "keywords": "comma, separated, terms",
      "timestamp": "${timestamp || new Date().toISOString()}",
      "archive": "${sessionId}.jsonl.archive"
    }
  ]
}
</JSONResponse>

IMPORTANT:
- Return 3-10 summaries based on conversation complexity
- Each summary should correspond to a memory you attempted to store
- If tool calls fail, still return the JSON response with summaries
- The JSON must be valid and complete
- Place NOTHING outside the <JSONResponse> tags
- Do not include any explanatory text before or after the JSON`;
  
  return prompt + '\n\n' + transcript + responseFormat;
}