# Response Formatting Guidelines

How to present search results to users.

## Format=Index Responses

When using `format=index`, present results as a **compact list**.

### Observations

```markdown
Found 5 results for "authentication":

1. **#1234** [feature] Implemented JWT authentication
   > Added token-based auth with refresh tokens
   > Nov 9, 2024 • claude-mem

2. **#1235** [bugfix] Fixed token expiration edge case
   > Handled race condition in refresh flow
   > Nov 9, 2024 • claude-mem

3. **#1236** [refactor] Simplified authentication middleware
   > Reduced code complexity by 40%
   > Nov 10, 2024 • claude-mem
```

**Include:**
- ID (for follow-up queries)
- Type with emoji (see below)
- Title
- Subtitle (one-line summary)
- Date and project

**Type Emojis:**
- 🔴 **bugfix**: Bug fixes
- 🟣 **feature**: New features
- 🔄 **refactor**: Code restructuring
- 🧠 **decision**: Architectural decisions
- 🔵 **discovery**: Learnings
- ✅ **change**: General changes

### Sessions

```markdown
Found 3 sessions about "deployment":

1. **Session #123** (Nov 8, 2024)
   > Deploy Docker container to production
   > Completed: Set up CI/CD pipeline, configured secrets

2. **Session #124** (Nov 9, 2024)
   > Fix deployment rollback issues
   > Completed: Added health checks, fixed rollback script
```

### Prompts

```markdown
Found 3 past prompts about "docker":

1. **Prompt #456** (Nov 8, 2024)
   > "Help me set up Docker for this project"

2. **Prompt #457** (Nov 9, 2024)
   > "Fix Docker compose networking issues"
```

---

## Format=Full Responses

When using `format=full`, present **complete details**.

### Observations (Full)

```markdown
### Observation #1234: Implemented JWT authentication

**Type:** Feature 🟣
**Project:** claude-mem
**Date:** Nov 9, 2024 3:30 PM

**Summary:** Added token-based auth with refresh tokens

**Details:**
Implemented a complete JWT authentication system for the API. The system uses
short-lived access tokens (15 minutes) combined with longer-lived refresh tokens
(7 days) to balance security and user experience. The implementation includes
middleware for route protection and automatic token refresh handling.

**Facts:**
- Used jsonwebtoken library (v9.0.2)
- Access tokens expire after 15 minutes
- Refresh tokens expire after 7 days
- Tokens include user ID and role claims
- Added rate limiting to auth endpoints

**Files Modified:**
- src/auth/jwt.ts (created, 145 lines)
- src/middleware/auth.ts (created, 78 lines)
- src/routes/auth.ts (created, 92 lines)
- tests/auth.test.ts (created, 234 lines)

**Concepts:** authentication, security, tokens, middleware
```

### Sessions (Full)

```markdown
### Session #123: Add user authentication (Nov 8, 2024)

**Request:** Implement JWT-based authentication for the API

**Completed:**
- Implemented JWT authentication system with access and refresh tokens
- Created authentication middleware for route protection
- Added login, logout, and token refresh endpoints
- Wrote comprehensive tests for auth flows
- Added rate limiting to prevent brute force attacks

**Learned:**
- JWT refresh token rotation is critical for security
- Need to handle token expiration gracefully on client side
- Rate limiting should be IP-based for auth endpoints
- Token blacklisting adds complexity, short expiration is simpler

**Next Steps:**
- Add password reset functionality
- Implement 2FA for admin accounts
- Add OAuth integration for social login

**Files Read:**
- docs/authentication-spec.md
- src/middleware/existing-auth.ts
- tests/integration/auth.test.ts

**Files Edited:**
- src/auth/jwt.ts (created)
- src/middleware/auth.ts (created)
- src/routes/auth.ts (created)
- tests/auth.test.ts (created)
```

---

## Timeline Responses

Present timeline results **chronologically grouped by day**.

```markdown
## Timeline around Observation #1234

**Window:** 10 records before → 10 records after
**Total:** 15 items (8 obs, 5 sessions, 2 prompts)

### Nov 8, 2024

**4:30 PM** - 🎯 **Session Request:** "Add user authentication"

**4:45 PM** - 🔵 **Discovery #1230:** "JWT library options compared"
> Evaluated 3 libraries: jsonwebtoken, jose, passport-jwt
> Chose jsonwebtoken for simplicity and community support

**5:00 PM** - 🧠 **Decision #1231:** "Chose jsonwebtoken for simplicity"
> jsonwebtoken has better TypeScript support and simpler API

**5:15 PM** - 🟣 **Feature #1232:** "Created JWT utility functions"
> Sign, verify, and decode token helpers

### Nov 9, 2024

**3:30 PM** - 🟣 **Feature #1234:** "Implemented JWT authentication"  ← ANCHOR
> Complete auth system with access and refresh tokens

**4:00 PM** - 🔴 **Bugfix #1235:** "Fixed token expiration edge case"
> Handled race condition in refresh flow

**4:30 PM** - ✅ **Change #1236:** "Updated API documentation"
> Added auth endpoint docs to README
```

**Legend:**
- 🎯 session-request
- 🔴 bugfix
- 🟣 feature
- 🔄 refactor
- ✅ change
- 🔵 discovery
- 🧠 decision

**Formatting Rules:**
1. Group by day with date headers
2. Show time for each item
3. Use emoji + type + ID/title
4. Indent subtitle/summary with `>`
5. Mark anchor point with `← ANCHOR`
6. Include legend at bottom

---

## Error Responses

### No Results

```markdown
No results found for "foobar". Try different search terms or:
- Check spelling
- Use broader terms
- Try synonyms
- Search by type or concept instead
```

### Service Unavailable

```markdown
Search service is not available. The claude-mem worker may not be running.

To check worker status:
\`\`\`bash
pm2 list
\`\`\`

To restart the worker:
\`\`\`bash
pm2 restart claude-mem-worker
\`\`\`

Would you like help troubleshooting?
```

---

## General Formatting Tips

1. **Use markdown formatting**: Bold, headers, code blocks, quotes
2. **Be concise**: Users want quick answers, not walls of text
3. **Highlight key information**: IDs, dates, types
4. **Group related items**: By day, by type, by file
5. **Offer follow-ups**: "Want more details?" "See timeline?"
6. **Use visual hierarchy**: Headers, lists, indentation
7. **Include context**: Project names, dates, related observations
8. **Make IDs clickable-ready**: **#1234** stands out for reference
