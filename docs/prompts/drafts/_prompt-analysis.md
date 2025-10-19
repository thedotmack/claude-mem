# Prompt Flow Analysis & Rankings

## Rating System
- ✅ **Smart**: Well-designed, clear purpose, effective
- ⚠️ **Problematic**: Has issues but salvageable
- ❌ **Stupid**: Poorly designed, confusing, or counterproductive
- 🧠 **Context Poison**: Will confuse the AI or create inconsistent behavior
- 🔍 **No Clear Purpose**: Exists but unclear why
- 🎯 **Clarity Score**: 1-10 (10 = crystal clear, 1 = incomprehensible)

---

## Element-by-Element Comparison

### INIT PROMPTS (Session Start)

#### CURRENT: "You are a memory processor"
```
You will PROCESS tool executions during this Claude Code session. Your job is to:
1. ANALYZE each tool response for meaningful content
2. DECIDE whether it contains something worth storing
3. EXTRACT the key insight
4. STORE it as an observation in the XML format below

For MOST meaningful tool outputs, you should generate an observation. Only skip truly routine operations.
```

**Rating**: ❌ **Stupid** + 🧠 **Context Poison**
**Clarity**: 3/10

**Issues**:
1. "For MOST" is ambiguous - does that mean 51%? 80%? 95%?
2. Creates bias toward over-storage (fear of missing things)
3. Contradicts "Only skip truly routine operations" later in prompt
4. No clear guidance on what "meaningful" actually means
5. "Only skip truly routine" implies almost everything should be stored

**Why Context Poison**:
- Agent will second-guess every decision
- Creates inconsistent thresholds across sessions
- User gets frustrated with noise

---

#### OLD: "You are a semantic memory compressor"
```
## FIRST: Generate Session Title
IMMEDIATELY generate a title and subtitle for this session based on the user request.

## THEN: Process Tool Responses
You will receive a stream of tool responses. For each one:
1. ANALYZE: Does this contain information worth remembering?
2. DECIDE: Should I store this or skip it?
3. EXTRACT: What are the key semantic concepts?
4. DECOMPOSE: Break into title + subtitle + atomic facts + narrative
5. STORE: Use bash to save the hierarchical memory
6. TRACK: Keep count of stored memories (001, 002, 003...)

# IMPORTANT REMINDERS
- Be selective - quality over quantity
```

**Rating**: ⚠️ **Problematic** but contains ✅ **Smart** elements
**Clarity**: 6/10

**Issues**:
1. "IMMEDIATELY" vs "THEN" creates ordering confusion
2. Session title generation is unclear when it should happen
3. Bash tool dependency is fragile
4. Manual counter tracking is error-prone

**Smart Elements**:
1. "Quality over quantity" is clear directive
2. Hierarchical decomposition gives structure
3. Explicit state tracking (counter)
4. "Be selective" is unambiguous

**Verdict**: The philosophy is better (selective, quality-focused), execution is messier (bash commands, ordering confusion)

---

### OBSERVATION PROMPTS

#### CURRENT: buildObservationPrompt
```
ANALYSIS TASK
-------------
ANALYZE this tool response and DECIDE: Does it contain something worth storing?

Most Read, Edit, Grep, Bash, and Write operations contain meaningful content.

If this contains something worth remembering, output the observation...
```

**Rating**: ❌ **Stupid** + 🧠 **Context Poison**
**Clarity**: 4/10

**Issues**:
1. "Most Read, Edit, Grep, Bash, and Write operations contain meaningful content" - Why repeat this per observation?
2. Contradicts init prompt's "be selective" guidance
3. Creates bias: agent thinks "well, this is a Read, so I should probably store it"
4. No guidance on WHAT to extract from the content
5. One-sentence observations lose context

**Why Context Poison**:
- Tool-type bias ("It's a Read, so store it") instead of content-based evaluation
- Encourages lazy pattern matching instead of semantic analysis
- Results in garbage like "Read package.json file" with no insight

---

#### OLD: Tool Message
```
# Tool Response {timeFormatted}

Tool: {toolName}
User Context: "{userPrompt}"

```
{toolResponse}
```

Analyze and store if meaningful.
```

**Rating**: ✅ **Smart** (minimal, non-leading)
**Clarity**: 8/10

**Smart Elements**:
1. Doesn't tell agent what to think about tool types
2. Trusts agent's judgment from system prompt
3. Short and clear
4. Includes user context for relevance filtering

**Issue**:
1. Maybe TOO minimal - no reminder of format requirements

---

### STORAGE FORMATS

#### CURRENT: XML Observations
```xml
<observation>
  <type>feature</type>
  <text>Implemented JWT token refresh flow with 7-day expiry</text>
</observation>
```

**Rating**: ⚠️ **Problematic**
**Clarity**: 7/10

**Issues**:
1. One sentence only - loses narrative context
2. Five types (decision, bugfix, feature, refactor, discovery) - are these actually useful categories?
3. No file associations
4. No concept tagging
5. Flat structure - all observations equal weight

**Smart Elements**:
1. Simple to parse
2. Structured typing
3. Regex-parseable

---

#### OLD: Hierarchical Memory (4 levels)
```bash
--title "SDK Transcript Auto-Cleanup"
--subtitle "Automatic deletion of SDK transcripts after completion prevents memory conversations from appearing in UI history"
--facts '["stop-streaming.js: Deletes SDK transcript after overview generation", "Path: ~/.claude/projects/{sanitized-cwd}/{sessionId}.jsonl"]'
--concepts '["cleanup", "SDK-lifecycle", "UX"]'
--files '["hooks/stop-streaming.js"]'
```

**Rating**: ✅ **Smart** (structure) but ❌ **Stupid** (execution via bash)
**Clarity**: 8/10 (concept), 3/10 (implementation)

**Smart Elements**:
1. Multiple levels of granularity (title → subtitle → facts → narrative)
2. Atomic facts enable precise retrieval
3. File associations explicit
4. Concept tags for categorization
5. Subtitle gives the "why it matters"

**Stupid Elements**:
1. Bash command execution is fragile
2. Quote escaping nightmare
3. Manual counter tracking
4. JSON in bash arguments is error-prone

**Verdict**: Great data model, terrible implementation

---

### SUMMARY/FINALIZE PROMPTS

#### CURRENT: buildFinalizePrompt (per prompt)
```xml
<summary>
  <request>Implement JWT authentication system</request>
  <investigated>Existing auth middleware, session management</investigated>
  <learned>Current system uses session cookies; no JWT support</learned>
  <completed>Implemented JWT token + refresh flow</completed>
  <next_steps>Add token revocation API endpoint</next_steps>
  <files_read><file>src/auth.ts</file></files_read>
  <files_edited><file>src/auth.ts</file></files_edited>
  <notes>Token secret stored in .env</notes>
</summary>
```

**Rating**: ✅ **Smart** (structure) but 🔍 **No Clear Purpose** (frequency)
**Clarity**: 9/10

**Smart Elements**:
1. Structured format with clear fields
2. Tracks what was learned (semantic value)
3. Files read/edited tracked explicitly
4. Next steps captured

**Issues**:
1. Generated PER PROMPT - is this too granular?
2. Will create many summaries per session
3. Unclear how these summaries are used
4. No aggregation across prompts

**Question**: Should this be per-session instead of per-prompt?

---

#### OLD: Session Overview (per session)
```bash
claude-mem store-overview --project "{project}" --session "{sessionId}" --content "2-3 sentence overview"
```

**Rating**: ⚠️ **Problematic**
**Clarity**: 5/10

**Issues**:
1. Only 2-3 sentences - very lossy
2. No structured fields
3. Happens once at end - loses per-prompt context
4. Relies on agent's memory of entire session

**Smart Element**:
1. One overview per session (not noisy)

---

### DECISION GUIDANCE

#### CURRENT: What to Store/Skip
```
Store these:
✓ File contents with logic, algorithms, or patterns
✓ Search results revealing project structure
✓ Build errors or test failures with context
...

Skip these:
✗ Simple status checks (git status with no changes)
✗ Trivial edits (one-line config changes)
...
```

**Rating**: ✅ **Smart**
**Clarity**: 8/10

**Smart Elements**:
1. Concrete examples
2. Both positive and negative cases
3. Action-oriented

**Issue**:
1. Contradicted by "For MOST" and "Most Read, Edit..." statements elsewhere

---

#### OLD: What to Store/Skip
```
Store these:
- File contents with logic, algorithms, or patterns
- Search results revealing project structure
...

Skip these:
- Simple status checks (git status with no changes)
- Trivial edits (one-line config changes)
- Binary data or noise
- Anything without semantic value
```

**Rating**: ✅ **Smart**
**Clarity**: 8/10

**Same as current**, which is good.

---

## CRITICAL ISSUES RANKED

### 1. "For MOST meaningful tool outputs" - 🧠 **CONTEXT POISON #1**
**Severity**: CRITICAL
**Impact**: Destroys selectivity, fills DB with noise
**Fix**: Remove entirely. Replace with: "Be selective. Only store if it reveals important information about the codebase."

---

### 2. "Most Read, Edit, Grep, Bash, and Write operations contain meaningful content" - 🧠 **CONTEXT POISON #2**
**Severity**: CRITICAL
**Impact**: Creates tool-type bias instead of content-based evaluation
**Fix**: Remove entirely. It's redundant and harmful.

---

### 3. One-sentence observations lose context - ❌ **STUPID**
**Severity**: HIGH
**Impact**: Can't understand observation without narrative
**Fix**: Add narrative field to observations (like old system)

---

### 4. No hierarchical structure in current system - ❌ **STUPID**
**Severity**: HIGH
**Impact**: Can't do granular retrieval (fact-level vs narrative-level)
**Fix**: Adopt 4-level hierarchy from old system

---

### 5. Bash command execution in old system - ❌ **STUPID**
**Severity**: HIGH
**Impact**: Fragile, error-prone, quote-escaping nightmare
**Fix**: Keep current approach (XML parsing + direct DB writes)

---

### 6. Manual memory counter in old system - ⚠️ **PROBLEMATIC**
**Severity**: MEDIUM
**Impact**: Agent forgets, skips numbers, duplicates
**Fix**: Auto-increment in database (current approach)

---

### 7. Per-prompt summaries unclear purpose - 🔍 **NO CLEAR PURPOSE**
**Severity**: MEDIUM
**Impact**: Creates many summaries, unclear how they're used
**Fix**: Decide: per-session summary only, or per-prompt with aggregation?

---

### 8. Five observation types unclear value - 🔍 **NO CLEAR PURPOSE**
**Severity**: LOW
**Impact**: Are these categories actually useful for retrieval?
**Fix**: Evaluate if types should be: (1) kept as-is, (2) expanded, (3) removed

---

## BEST ELEMENTS FROM EACH SYSTEM

### From OLD System (Keep These)
1. ✅ 4-level hierarchy (title → subtitle → facts → narrative)
2. ✅ "Be selective - quality over quantity"
3. ✅ Atomic facts (50-150 char, self-contained, no pronouns)
4. ✅ Concept tagging
5. ✅ File associations
6. ✅ Minimal observation prompts (don't bias agent)

### From CURRENT System (Keep These)
1. ✅ XML parsing (not bash commands)
2. ✅ Auto-increment IDs (not manual counters)
3. ✅ Structured summary format (8 fields)
4. ✅ Per-prompt tracking
5. ✅ Foreign key integrity
6. ✅ Typed observations (decision/bugfix/feature/refactor/discovery)

### From NEITHER System (Add These)
1. Clear threshold guidance: "Only store if it reveals important information about the codebase"
2. Explicit narrative field in observations
3. Vector embeddings for semantic search (current stores in SQLite only)

---

## RECOMMENDED HYBRID SYSTEM

### Storage Format: Hierarchical Observations (XML)
```xml
<observation>
  <type>feature</type>
  <title>JWT Token Refresh Implementation</title>
  <subtitle>Added 7-day refresh token rotation with Redis storage</subtitle>
  <facts>
    <fact>src/auth.ts: refreshToken() generates new JWT with 7-day expiry</fact>
    <fact>Redis key format: refresh:{userId}:{tokenId} with TTL 604800s</fact>
    <fact>Old token invalidated on refresh to prevent replay attacks</fact>
  </facts>
  <narrative>Implemented JWT refresh token functionality in src/auth.ts. The refreshToken() function validates the old refresh token from Redis, generates a new JWT access token (7-day expiry) and new refresh token, stores the new refresh token in Redis with key format refresh:{userId}:{tokenId} and TTL of 604800 seconds (7 days), and invalidates the old refresh token to prevent replay attacks. This enables long-lived authenticated sessions without requiring users to re-login while maintaining security through token rotation.</narrative>
  <concepts>
    <concept>authentication</concept>
    <concept>security</concept>
    <concept>session-management</concept>
  </concepts>
  <files>
    <file>src/auth.ts</file>
    <file>src/middleware/auth.ts</file>
  </files>
</observation>
```

### Guidance: Clear and Unambiguous
```
Be selective. Only store observations when the tool output reveals important information about:
- Architecture or design patterns
- Implementation details of features or bug fixes
- System state or configuration
- Business logic or algorithms

Skip routine operations like empty git status, simple npm installs, or trivial config changes.

Each observation should be self-contained and searchable.
```

### Summary: Per-Session (Not Per-Prompt)
- Generate ONE summary when session ends
- Aggregate all observations from session
- Use current structured format (request, investigated, learned, completed, next_steps, files_read, files_edited, notes)

---

## FINAL VERDICT

| Element | Current | Old | Winner |
|---------|---------|-----|--------|
| **Storage Structure** | Flat one-sentence | 4-level hierarchy | **OLD** |
| **Storage Implementation** | XML parsing | Bash commands | **CURRENT** |
| **Decision Guidance** | Contradictory | Clear | **OLD** |
| **Session Metadata** | None | Title + subtitle | **OLD** |
| **Per-Prompt Tracking** | Yes (summaries) | No | **CURRENT** |
| **Semantic Search** | No | Yes (ChromaDB) | **OLD** |
| **Observation Prompts** | Biased, repetitive | Minimal, clear | **OLD** |
| **Auto-Increment IDs** | Yes | No (manual) | **CURRENT** |
| **File Associations** | No | Yes | **OLD** |
| **Concept Tagging** | No | Yes | **OLD** |

**Optimal System**: Hybrid - Old system's data model + Current system's implementation approach
