# Rich Context Examples

This document shows what contextual data is available in transcripts
that could improve observation generation quality.

## Statistics

- Total entries: 369
- User messages: 74
- Assistant messages: 133
- Token usage: 67,465 total
- Cache efficiency: 6,979,410 tokens read from cache

## Conversation Flow

This shows how user requests, assistant reasoning, and tool executions flow together.
This is the rich context currently missing from individual tool observations.

---

### Example 1

#### 👤 User Request
```
Thank you for that. So now that you have a very deep understanding of what we are doing here, I'd like you to begin working on the enhancements to our prompts that leverage data using the transcript model we discovered
```

#### 🔧 Tools Executed (1)

**TodoWrite**
```json
{
  "todos": [
    {
      "content": "Read the ROI implementation plan to understand full scope",
      "status": "in_progress",
      "activeForm": "Reading ROI implementation plan"
    },
    {
   
```

**📊 Data Available for This Exchange:**
- User intent: ✅ (218 chars)
- Assistant reasoning: ✅ (0 chars)
- Thinking process: ❌ 
- Tool executions: ✅ (1 tools)
- **Currently sent to memory worker:** Tool inputs/outputs only (no context!) ❌

---

### Example 2

#### 👤 User Request
```
Thank you for that. So now that you have a very deep understanding of what we are doing here, I'd like you to begin working on the enhancements to our prompts that leverage data using the transcript model we discovered
```

#### 🔧 Tools Executed (1)

**Glob**
- Pattern: `**/*roi*`

**📊 Data Available for This Exchange:**
- User intent: ✅ (218 chars)
- Assistant reasoning: ✅ (0 chars)
- Thinking process: ❌ 
- Tool executions: ✅ (1 tools)
- **Currently sent to memory worker:** Tool inputs/outputs only (no context!) ❌

---

### Example 3

#### 👤 User Request
```
Thank you for that. So now that you have a very deep understanding of what we are doing here, I'd like you to begin working on the enhancements to our prompts that leverage data using the transcript model we discovered
```

#### 🔧 Tools Executed (1)

**Glob**
- Pattern: `**/*implementation*plan*`

**📊 Data Available for This Exchange:**
- User intent: ✅ (218 chars)
- Assistant reasoning: ✅ (0 chars)
- Thinking process: ❌ 
- Tool executions: ✅ (1 tools)
- **Currently sent to memory worker:** Tool inputs/outputs only (no context!) ❌

---

### Example 4

#### 👤 User Request
```
Thank you for that. So now that you have a very deep understanding of what we are doing here, I'd like you to begin working on the enhancements to our prompts that leverage data using the transcript model we discovered
```

#### 🔧 Tools Executed (1)

**Read**
- Reading: `/Users/alexnewman/Scripts/claude-mem/docs/context/transcript-data-discovery.md`

**📊 Data Available for This Exchange:**
- User intent: ✅ (218 chars)
- Assistant reasoning: ✅ (0 chars)
- Thinking process: ❌ 
- Tool executions: ✅ (1 tools)
- **Currently sent to memory worker:** Tool inputs/outputs only (no context!) ❌

---

### Example 5

#### 👤 User Request
```
Thank you for that. So now that you have a very deep understanding of what we are doing here, I'd like you to begin working on the enhancements to our prompts that leverage data using the transcript model we discovered
```

#### 🔧 Tools Executed (1)

**Read**
- Reading: `/Users/alexnewman/Scripts/claude-mem/IMPLEMENTATION_PLAN_ROI_METRICS.md`

**📊 Data Available for This Exchange:**
- User intent: ✅ (218 chars)
- Assistant reasoning: ✅ (0 chars)
- Thinking process: ❌ 
- Tool executions: ✅ (1 tools)
- **Currently sent to memory worker:** Tool inputs/outputs only (no context!) ❌


---

## Key Insight

Currently, the memory worker receives **isolated tool executions** via save-hook:
- tool_name: "Read"
- tool_input: {"file_path": "src/foo.ts"}
- tool_output: {file contents}

But the transcript contains **rich contextual data**:
- WHY the tool was used (user's request)
- WHAT the assistant planned to accomplish
- HOW it fits into the broader task
- The assistant's reasoning/thinking
- Multiple related tools used together

This context would help the memory worker:
1. Understand if a tool use is meaningful or routine
2. Generate observations that capture WHY, not just WHAT
3. Group related tools into coherent actions
4. Avoid "investigating" - the context is already present

