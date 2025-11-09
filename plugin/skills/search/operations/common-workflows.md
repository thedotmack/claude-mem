# Common Workflows

Step-by-step guides for typical user requests.

## Workflow 1: Understanding Past Work

**User asks:** "What did we do last session?"

**Steps:**
1. Use [recent-context.md](recent-context.md) to get last 3 sessions
2. Parse and format the summary, observations, and outcomes
3. Present in readable markdown

**Example:**
```bash
RESULT=$(curl -s "http://localhost:37777/api/context/recent?limit=3")
# Parse JSON and format for user
```

**Present as:**
- Show session request
- List key accomplishments
- Highlight important observations
- Note any next steps

---

## Workflow 2: Finding a Specific Bug Fix

**User asks:** "Did we fix the login timeout issue?"

**Steps:**
1. Search observations with [by-type.md](by-type.md): `type=bugfix`
2. Or use [observations.md](observations.md): `query=login+timeout`
3. If results found, show title + subtitle + ID
4. Offer to get more details or timeline context

**Example:**
```bash
# Option 1: Search by type
curl -s "http://localhost:37777/api/search/by-type?type=bugfix&limit=20&format=index"

# Option 2: Full-text search
curl -s "http://localhost:37777/api/search/observations?query=login+timeout&format=index&limit=10"
```

**Present as:**
- List matching bugfixes
- Include observation ID for follow-up
- Offer to show full details or timeline

---

## Workflow 3: Understanding File History

**User asks:** "What changes have we made to auth/login.ts?"

**Steps:**
1. Use [by-file.md](by-file.md) to search by file path
2. Get both observations and sessions
3. Sort chronologically and present

**Example:**
```bash
curl -s "http://localhost:37777/api/search/by-file?filePath=auth/login.ts&limit=10&format=index"
```

**Present as:**
- Chronological list of changes
- Separate observations and sessions
- Include what changed and when
- Highlight recent modifications

---

## Workflow 4: Timeline Investigation

**User asks:** "What were we working on around the time of that deployment?"

**Steps:**
1. Use [timeline-by-query.md](timeline-by-query.md) for one-shot query
2. Or two-step: search for "deployment" to get ID, then use [timeline.md](timeline.md)

**Option 1 (Recommended): One request**
```bash
curl -s "http://localhost:37777/api/timeline/by-query?query=deployment&depth_before=10&depth_after=10"
```

**Option 2: Two requests**
```bash
# Step 1: Find the deployment
curl -s "http://localhost:37777/api/search/observations?query=deployment&format=index&limit=5"
# Get observation ID (e.g., #1234)

# Step 2: Get timeline around it
curl -s "http://localhost:37777/api/context/timeline?anchor=1234&depth_before=10&depth_after=10"
```

**Present as:**
- Show the anchor point (deployment observation)
- Chronological timeline grouped by day
- Highlight observations, sessions, and prompts
- Use emojis for visual clarity

---

## Workflow 5: Understanding Decisions

**User asks:** "Why did we choose PostgreSQL over MySQL?"

**Steps:**
1. Search for decisions using [by-type.md](by-type.md): `type=decision`
2. Filter results for "PostgreSQL" or "MySQL"
3. Show the decision observation with full context

**Example:**
```bash
curl -s "http://localhost:37777/api/search/by-type?type=decision&limit=20&format=index"
# Then search results for database-related decisions
```

Or use full-text search:
```bash
curl -s "http://localhost:37777/api/search/observations?query=PostgreSQL+MySQL+decision&format=full&limit=5"
```

**Present as:**
- Show the decision with full narrative
- Include facts and rationale
- Link to related observations if available

---

## Workflow 6: Exploring a Topic

**User asks:** "What have we learned about authentication?"

**Steps:**
1. Use [observations.md](observations.md) for full-text search
2. Filter by type=discovery for learnings
3. Or use [by-concept.md](by-concept.md) for concept=discovery

**Example:**
```bash
# Full-text search
curl -s "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=20"

# Or discoveries only
curl -s "http://localhost:37777/api/search/by-type?type=discovery&limit=20&format=index"
# Then filter for "authentication" in results
```

**Present as:**
- Group by type (features, bugs, decisions, discoveries)
- Show progression of work over time
- Highlight key learnings

---

## Tips for All Workflows

1. **Start with format=index** for overviews, then format=full for details
2. **Use limit=5-10** initially, expand if needed
3. **Combine operations** for comprehensive answers
4. **Offer follow-ups**: "Want more details?" "See timeline context?"
5. **Use project filtering** when working on one codebase
