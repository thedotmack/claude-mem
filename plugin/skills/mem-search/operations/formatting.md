# Response Formatting Guidelines

How to present search results to users for maximum clarity and usefulness.

## General Principles

1. **Progressive disclosure** - Show index results first, full details on demand
2. **Visual hierarchy** - Use emojis, bold, and structure for scannability
3. **Context-aware** - Tailor presentation to user's question
4. **Actionable** - Include IDs for follow-up queries
5. **Token-efficient** - Balance detail with token budget

---

## Format: Index Results

**When to use:** First response to searches, overviews, multiple results

**Structure:**
```markdown
Found {count} results for "{query}":

{emoji} **#{id}** {title}
   > {subtitle}
   > {date} • {project}
```

**Example:**
```markdown
Found 5 results for "authentication":

🟣 **#1234** Implemented JWT authentication
   > Added token-based auth with refresh tokens
   > Nov 9, 2024 • api-server

🔴 **#1235** Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024 • api-server
```

**Type Emojis:**
- 🔴 bugfix
- 🟣 feature
- 🔄 refactor
- 🔵 discovery
- 🧠 decision
- ✅ change
- 🎯 session
- 💬 prompt

**What to include:**
- ✅ ID (for follow-up)
- ✅ Type emoji
- ✅ Title
- ✅ Subtitle (if available)
- ✅ Date (human-readable)
- ✅ Project name
- ❌ Don't include full narrative/facts/files in index format

---

## Format: Full Results

**When to use:** User requests details, specific items selected from index

**Structure:**
```markdown
## {emoji} {type} #{id}: {title}

**Summary:** {subtitle}

**What happened:**
{narrative}

**Key Facts:**
- {fact1}
- {fact2}

**Files modified:**
- {file1}
- {file2}

**Concepts:** {concepts}

**Date:** {human_readable_date}
**Project:** {project}
```

**Example:**
```markdown
## 🟣 Feature #1234: Implemented JWT authentication

**Summary:** Added token-based auth with refresh tokens

**What happened:**
Implemented a complete JWT authentication system with access and refresh tokens. Access tokens expire after 15 minutes, refresh tokens after 7 days. Added token signing with RS256 algorithm and proper key rotation infrastructure.

**Key Facts:**
- Access tokens use 15-minute expiration
- Refresh tokens stored in httpOnly cookies
- RS256 algorithm with key rotation support
- Token refresh endpoint handles race conditions gracefully

**Files modified:**
- src/auth/jwt.ts (created)
- src/auth/refresh.ts (created)
- src/middleware/auth.ts (modified)

**Concepts:** how-it-works, pattern

**Date:** November 9, 2024 at 2:55 PM
**Project:** api-server
```

**What to include:**
- ✅ Full title with emoji and ID
- ✅ Summary/subtitle
- ✅ Complete narrative
- ✅ All key facts
- ✅ All files (with status: created/modified/deleted)
- ✅ Concepts/tags
- ✅ Precise timestamp
- ✅ Project name

---

## Format: Timeline Results

**When to use:** Temporal investigations, "what was happening" questions

**Structure:**
```markdown
## Timeline: {anchor_description}

### Before ({count} records)

**{time}** - {emoji} {type} #{id}: {title}
**{time}** - {emoji} {type} #{id}: {title}

### ⭐ Anchor Point ({time})
{emoji} **{type} #{id}**: {title}

### After ({count} records)

**{time}** - {emoji} {type} #{id}: {title}
**{time}** - {emoji} {type} #{id}: {title}
```

**Example:**
```markdown
## Timeline: Deployment

### Before (10 records)

**2:30 PM** - 🟣 #1230: Prepared deployment scripts
**2:45 PM** - 🔄 #1232: Updated configuration files
**2:50 PM** - 💬 User asked: "Are we ready to deploy?"

### ⭐ Anchor Point (2:55 PM)
🎯 **Session #545**: Deployed to production

### After (10 records)

**3:00 PM** - 🔴 #1235: Fixed post-deployment routing issue
**3:10 PM** - 🔵 #1236: Discovered caching behavior in production
**3:15 PM** - 🧠 #1237: Decided to add health check endpoint
```

**What to include:**
- ✅ Chronological ordering (oldest to newest)
- ✅ Human-readable times (not epochs)
- ✅ Clear anchor point marker (⭐)
- ✅ Mix of all record types (observations, sessions, prompts)
- ✅ Concise titles (not full narratives)
- ✅ Type emojis for quick scanning

---

## Format: Session Summaries

**When to use:** Recent context, "what did we do" questions

**Structure:**
```markdown
## Recent Work on {project}

### 🎯 Session #{id} - {date}

**Request:** {user_request}

**Completed:**
- {completion1}
- {completion2}

**Key Learning:** {learning}

**Observations:**
- {emoji} **#{obs_id}** {obs_title}
  - Files: {file_list}
```

**Example:**
```markdown
## Recent Work on api-server

### 🎯 Session #545 - November 9, 2024

**Request:** Add JWT authentication with refresh tokens

**Completed:**
- Implemented token-based auth with refresh logic
- Added JWT signing and verification
- Created refresh token rotation

**Key Learning:** JWT expiration requires careful handling of refresh race conditions

**Observations:**
- 🟣 **#1234** Implemented JWT authentication
  - Files: jwt.ts, refresh.ts, middleware/auth.ts
- 🔴 **#1235** Fixed token expiration edge case
  - Files: refresh.ts
```

**What to include:**
- ✅ Session ID and date
- ✅ Original user request
- ✅ What was completed (bulleted list)
- ✅ Key learnings/insights
- ✅ Linked observations with file lists
- ✅ Clear hierarchy (session → observations)

---

## Format: User Prompts

**When to use:** "What did I ask" questions, prompt searches

**Structure:**
```markdown
Found {count} user prompts:

💬 **Prompt #{id}** (Session #{session_id})
   > "{preview_text}"
   > {date} • {project}
```

**Example:**
```markdown
Found 5 user prompts about "authentication":

💬 **Prompt #1250** (Session #545)
   > "How do I implement JWT authentication with refresh tokens? I need to handle token expiration..."
   > Nov 9, 2024 • api-server

💬 **Prompt #1251** (Session #546)
   > "The auth tokens are expiring too quickly. Can you help debug the refresh flow?"
   > Nov 8, 2024 • api-server
```

**What to include:**
- ✅ Prompt ID
- ✅ Session ID (for context linking)
- ✅ Preview text (200 chars for index, full text for full format)
- ✅ Date and project
- ✅ Quote formatting for prompt text

---

## Error Responses

**No results found:**
```markdown
No results found for "{query}". Try:
- Different search terms
- Broader keywords
- Checking spelling
- Using partial paths (for file searches)
```

**Service unavailable:**
```markdown
The search service isn't available. Check if the worker is running:

```bash
pm2 list
```

If the worker is stopped, restart it:

```bash
npm run worker:restart
```
```

**Invalid parameters:**
```markdown
Invalid search parameters:
- {parameter}: {error_message}

See the [API help](help.md) for valid parameter options.
```

---

## Context-Aware Presentation

Tailor formatting to user's question:

**"What bugs did we fix?"**
→ Use index format, emphasize date/type, group by recency

**"How did we implement X?"**
→ Use full format for best match, include complete narrative and files

**"What was happening when..."**
→ Use timeline format, emphasize chronology and causality

**"Catch me up on recent work"**
→ Use session summary format, focus on high-level accomplishments

---

## Token Budget Guidelines

**Minimal presentation (~100-200 tokens):**
- Index format with 3-5 results
- Compact list structure
- Essential metadata only

**Standard presentation (~500-1,000 tokens):**
- Index format with 10-15 results
- Include subtitles and context
- Clear formatting and emojis

**Detailed presentation (~1,500-3,000 tokens):**
- Full format for 2-3 items
- Complete narratives and facts
- Timeline with 20-30 records

**Comprehensive presentation (~5,000+ tokens):**
- Multiple full results
- Deep timelines (40+ records)
- Session summaries with observations

Always start minimal, expand only when needed.

---

## Markdown Best Practices

1. **Use headers (##, ###)** for hierarchy
2. **Bold important elements** (IDs, titles, dates)
3. **Quote user text** (prompts, questions)
4. **Bullet lists** for facts and files
5. **Code blocks** for commands and examples
6. **Emojis** for type indicators
7. **Horizontal rules (---)** for section breaks
8. **Blockquotes (>)** for subtitles and previews

---

## Examples by Use Case

### Use Case 1: Quick Overview
User: "What did we do last session?"

```markdown
## Recent Work

### 🎯 Session #545 - November 9, 2024
Implemented JWT authentication system

**Key accomplishment:** Added token-based auth with refresh tokens
**Key learning:** JWT expiration requires careful handling of refresh race conditions
```

### Use Case 2: Specific Investigation
User: "How did we implement JWT authentication?"

```markdown
## 🟣 Feature #1234: Implemented JWT authentication

**What happened:**
Implemented a complete JWT authentication system with access and refresh tokens. Access tokens expire after 15 minutes, refresh tokens after 7 days. Added token signing with RS256 algorithm.

**Files:**
- src/auth/jwt.ts (created)
- src/auth/refresh.ts (created)
- src/middleware/auth.ts (modified)

**Key insight:** Refresh race conditions require atomic token exchange logic.
```

### Use Case 3: Timeline Investigation
User: "What was happening around the deployment?"

```markdown
## Timeline: Deployment

[... chronological timeline with before/after context ...]
```

Choose presentation style based on user's question and information needs.
