# Common Workflows

Step-by-step guides for typical user requests using the search API.

## Workflow 1: Understanding Past Work

**User asks:** "What did we do last session?" or "Catch me up on recent work"

**Steps:**

1. **Get recent context** (fastest path):
```bash
curl -s "http://localhost:37777/api/context/recent?limit=3"
```

2. **Present as narrative:**
```markdown
## Recent Work

### Session #545 - Nov 9, 2024
Implemented JWT authentication system

**Completed:**
- Added token-based auth with refresh tokens
- Created JWT signing and verification logic

**Key Learning:** JWT expiration requires careful handling of refresh race conditions
```

**Why this workflow:**
- Single request gets both sessions and observations
- Optimized for "catch me up" questions
- ~1,500-2,500 tokens for 3 sessions

---

## Workflow 2: Finding Specific Bug Fixes

**User asks:** "What bugs did we fix?" or "Show me recent bug fixes"

**Steps:**

1. **Search by type** (index format first):
```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&format=index&limit=5"
```

2. **Review index results**, identify relevant items

3. **Get full details** for specific bugs:
```bash
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&format=full&limit=1&offset=2"
```

4. **Present findings:**
```markdown
Found 5 bug fixes:

🔴 **#1235** Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024 • api-server

[Click for full details on #1235]
```

**Why this workflow:**
- Progressive disclosure: index first, full details selectively
- Type-specific search is more efficient than generic search
- ~250-500 tokens for index, ~750-1000 per full detail

---

## Workflow 3: Understanding File History

**User asks:** "What changes to auth/login.ts?" or "Show me work on this file"

**Steps:**

1. **Search by file** (index format):
```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=auth/login.ts&format=index&limit=10"
```

2. **Review chronological changes**

3. **Get full details** for specific changes:
```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=auth/login.ts&format=full&limit=1&offset=3"
```

4. **Present as file timeline:**
```markdown
## History of auth/login.ts

🟣 **#1230** Added JWT authentication (Nov 9)
🔴 **#1235** Fixed token expiration bug (Nov 9)
🔄 **#1240** Refactored auth flow (Nov 8)
```

**Why this workflow:**
- File-specific search finds all related work
- Index format shows chronological overview
- Selective full details for deep dives

---

## Workflow 4: Timeline Investigation

**User asks:** "What was happening when we deployed?" or "Show me context around that bug fix"

**Steps:**

1. **Find the event** using search:
```bash
curl -s "http://localhost:37777/api/search/observations?query=deployment&format=index&limit=5"
```

2. **Note observation ID** (e.g., #1234)

3. **Get timeline context**:
```bash
curl -s "http://localhost:37777/api/timeline/context?anchor=1234&depth_before=10&depth_after=10"
```

4. **Present as chronological narrative:**
```markdown
## Timeline: Deployment

### Before (10 records)
**2:45 PM** - 🟣 Prepared deployment scripts
**2:50 PM** - 💬 User asked: "Are we ready to deploy?"

### ⭐ Anchor Point (2:55 PM)
🎯 **Observation #1234**: Deployed to production

### After (10 records)
**3:00 PM** - 🔴 Fixed post-deployment routing issue
```

**Why this workflow:**
- Timeline shows temporal context (what happened before/after)
- Captures causality between events
- All record types (observations, sessions, prompts) interleaved

---

## Workflow 5: Quick Timeline (One Request)

**User asks:** "Timeline of authentication work"

**Steps:**

1. **Use timeline-by-query** (auto mode):
```bash
curl -s "http://localhost:37777/api/timeline/by-query?query=authentication&mode=auto&depth_before=10&depth_after=10"
```

2. **Present timeline directly:**
```markdown
## Timeline: Authentication

**Best Match:** 🟣 Observation #1234 - Implemented JWT authentication

### Context (21 records)
[... timeline around best match ...]
```

**Why this workflow:**
- Single request combines search + timeline
- Fastest path when query is specific
- Auto mode uses top result as anchor

**Alternative:** Use interactive mode for broad queries:
```bash
curl -s "http://localhost:37777/api/timeline/by-query?query=auth&mode=interactive&limit=5"
```
Then choose anchor manually.

---

## Workflow 6: Search Composition

**User asks:** "What features did we add to the authentication system recently?"

**Steps:**

1. **Combine filters** for precision:
```bash
curl -s "http://localhost:37777/api/search/observations?query=authentication&type=feature&dateStart=2024-11-01&format=index&limit=10"
```

2. **Review filtered results**

3. **Get full details** for relevant features:
```bash
curl -s "http://localhost:37777/api/search/observations?query=authentication&type=feature&format=full&limit=1&offset=2"
```

4. **Present findings:**
```markdown
Found 10 authentication features added in November:

🟣 **#1234** Implemented JWT authentication (Nov 9)
🟣 **#1236** Added refresh token rotation (Nov 9)
🟣 **#1238** Implemented OAuth2 flow (Nov 7)
```

**Why this workflow:**
- Multiple filters narrow results before requesting full details
- Type + query + dateStart/dateEnd = precise targeting
- Progressive disclosure: index first, full details selectively

---

## Workflow Selection Guide

| User Request | Workflow | Operation | Token Cost |
|--------------|----------|-----------|------------|
| "What did we do last session?" | #1 | recent-context | 1,500-2,500 |
| "What bugs did we fix?" | #2 | by-type | 500-3,000 |
| "What changes to file.ts?" | #3 | by-file | 500-3,000 |
| "What was happening then?" | #4 | search → timeline | 3,500-6,000 |
| "Timeline of X work" | #5 | timeline-by-query | 3,000-4,000 |
| "Recent features added?" | #6 | observations + filters | 500-3,000 |

## General Principles

1. **Start with index format** - Always use `format=index` first
2. **Use specialized tools** - by-type, by-file, by-concept when applicable
3. **Compose operations** - Combine search + timeline for investigations
4. **Filter early** - Use type, dateStart/dateEnd, project to narrow before expanding
5. **Progressive disclosure** - Load full details only for relevant items

## Token Budget Awareness

**Quick queries** (500-1,500 tokens):
- Recent context (limit=3)
- Index search (limit=5-10)
- Filtered searches

**Medium queries** (1,500-4,000 tokens):
- Recent context (limit=5-10)
- Full details (3-5 items)
- Timeline (depth 10/10)

**Deep queries** (4,000-8,000 tokens):
- Timeline (depth 20/20)
- Full details (10+ items)
- Multiple composed operations

Always start with minimal token investment, expand only when needed.
