/**
 * The `mem-search` runtime skill: guidance for the model on the three-layer
 * Smart search workflow (search → timeline → selected get_observations) over the `mem_*` tools.
 * @module dsh-claude-mem/skill
 */


const MEM_SEARCH_SKILL_NAME = 'mem-search'
const MEM_SEARCH_SKILL_DESCRIPTION = 'Smart search (default). Search persistent cross-session memory. Use when the user asks "did we already solve this?", "how did we do X last time?", or needs work from previous sessions.'

const MEM_SEARCH_SKILL_CONTENT = `# Smart Search (Default)

Search past work across all sessions. Follow this three-step workflow: search → timeline → selected get_observations. Reason about the index and context before choosing details. Do not use auto or guided modes.

## When to Use

Use when users ask about PREVIOUS sessions (not the current conversation):

- "Did we already fix this?"
- "How did we solve X last time?"
- "What happened last week?"

## 3-Layer Workflow (ALWAYS Follow)

NEVER fetch full details without filtering first. This saves 10x tokens.

### Step 1: Search — get an index with ids

Use the \`mem_search\` tool with a free-text query. It returns ids, titles, and types.
Omit \`platformSource\` to search ALL memory; set it only to restrict to your own platform's memory.

### Step 2: Timeline — inspect context around interesting results

Use \`mem_timeline\` around the candidate observation ids. Review the index and timeline together, then choose only ids relevant to the question.

### Step 3: Fetch — get full details only for the filtered ids

Use \`mem_get_observations\` with only the ids selected after reviewing the index and timeline. Batch related ids in one request.

For the worker's own session-start context text, use \`mem_context\`.
`

/** The runtime skill registration object accepted by \`ctx.skills.register()\`. */
export const memSearchSkill = {
  name: MEM_SEARCH_SKILL_NAME,
  description: MEM_SEARCH_SKILL_DESCRIPTION,
  source: 'bundled',
  content: MEM_SEARCH_SKILL_CONTENT,
} as const
