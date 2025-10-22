# Claude Never Forgets

**Give Claude a memory that spans your entire project.**

---

## The Problem

```
You: "Remember that bug we fixed last Tuesday with the auth flow?"
Claude: "I don't have access to previous conversations..."
```

Every `/clear` wipes Claude's memory. Every new session starts from zero. You repeat yourself constantly.

**Until now.**

---

## What Changes

### Before claude-mem
```typescript
// Monday: You debug an issue
You: "Why is the database connection failing?"
Claude: [Helps you fix it]

// Wednesday: Similar issue appears
You: "The database is timing out again"
Claude: "Let me investigate..." [Starts from scratch]
```

### After claude-mem
```typescript
// Monday: You debug an issue
You: "Why is the database connection failing?"
Claude: [Helps you fix it]
✓ Remembers: connection pool exhaustion pattern

// Wednesday: Similar issue appears
You: "The database is timing out again"
Claude: "Based on Monday's session, this looks like the same
        connection pool issue. Let me check the pool size config..."
```

Claude **remembers**. Claude **learns**. Claude gets **better** over time.

---

## Real Examples

### 1. **Context Across Sessions**

**Without claude-mem:**
```
Session 1: "We use Redux for state management"
Session 2: "What state management do you use?" ❌
```

**With claude-mem:**
```
Session 1: "We use Redux for state management"
Session 2: Claude already knows you use Redux ✓
         Suggests Redux patterns automatically ✓
         References your store structure ✓
```

### 2. **Architectural Memory**

**Your third session of the day:**
```
You: "Add a new API endpoint for user preferences"

Claude: "I see from previous sessions that:
- Your API follows REST conventions in src/api/
- You use Zod for validation
- Auth middleware is required for user routes
- You prefer async/await over promises

I'll create the endpoint following these patterns..."
```

**No explaining. No repeating. Just building.**

### 3. **Bug Pattern Recognition**

```
Week 1: Fixed race condition in webhook handler
Week 2: Different race condition in event processor

Claude: "This looks similar to the webhook race condition
        we fixed last week. The same solution should work..."
```

---

## How It Works

```
┌─────────────────┐
│  You code with  │
│  Claude today   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│  claude-mem captures &      │
│  compresses everything       │
│  into structured memories    │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│  Tomorrow, Claude starts     │
│  with full context of        │
│  your project history        │
└─────────────────────────────┘
```

**Automatic. Zero effort. Always on.**

---

## What Gets Remembered

✓ **Decisions**: "Why did we choose this architecture?"
✓ **Bugs Fixed**: "How did we solve this before?"
✓ **Code Patterns**: "What's our convention for this?"
✓ **File Changes**: "What did we modify last session?"
✓ **Refactorings**: "What was the old implementation?"
✓ **Dependencies**: "Which libraries are we using?"

Everything Claude does with you gets compressed into **searchable, reusable memory**.

---

## Powerful Search

Ask Claude to search your project history:

```
You: "Find all the database migrations we did"
Claude: [Searches across all sessions]
        "I found 7 database-related changes:
        - March 15: Added user_preferences table
        - March 12: Migration for OAuth tokens
        - March 8: Index optimization on sessions
        ..."

You: "What decisions did we make about authentication?"
Claude: [Retrieves decision observations]
        "We decided to use JWT tokens because..."
```

7 specialized search tools. Instant recall. Full project history.

---

## The Numbers

| Metric | Before | After |
|--------|--------|-------|
| Context repetition | Every session | Never |
| Onboarding time | 5-10 min per session | 0 seconds |
| Bug re-investigation | Common | Rare |
| Architectural questions | "What did we decide?" | Claude already knows |
| Code pattern consistency | Manual enforcement | Automatic |

---

## Installation

### Quick Start (2 minutes)

```bash
# 1. Clone and install
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem

# 2. Add to Claude Code
/plugin marketplace add .claude-plugin/marketplace.json

# 3. Install
/plugin install claude-mem
```

**Done.** Claude now has memory.

---

## Configuration

Choose your AI model (controls cost vs. quality of memory compression):

```bash
./claude-mem-settings.sh
```

**Models:**
- `claude-haiku-4-5` - Fast & cheap
- `claude-sonnet-4-5` - Balanced (default) ✓
- `claude-opus-4` - Maximum quality

---

## Under The Hood

**Simple architecture, powerful results:**

1. **Hooks** capture every tool Claude uses
2. **Worker service** compresses observations with AI
3. **SQLite database** stores structured memories
4. **MCP server** makes everything searchable
5. **Context injection** gives Claude the right memories at the right time

**Zero maintenance. Runs in the background. Just works.**

---

## Use Cases

### Solo Developers
- Never lose context between coding sessions
- Build on past decisions automatically
- Remember why you made each choice

### Team Projects
- Share architectural knowledge across sessions
- Maintain consistency in code patterns
- Document decisions as they happen

### Learning & Experiments
- Track what you tried and what worked
- Build a personal knowledge base
- Learn from past mistakes

### Large Refactors
- Remember what you changed across multiple sessions
- Track progress on multi-day tasks
- Maintain context through interruptions

---

## What Developers Say

> *"I used to spend 10 minutes every morning explaining my project to Claude. Now it just knows."*

> *"It's like having a teammate who was actually there for every line of code."*

> *"The search is incredible. I can ask about decisions we made weeks ago."*

---

## FAQ

**Does this slow down Claude?**
No. Memory processing happens in the background. Claude responds instantly.

**How much does it cost?**
Minimal. Memory compression uses your chosen model (default: Sonnet 4.5). Typical cost: $0.01-0.05 per coding session.

**Where is data stored?**
Locally in `~/.claude-mem/claude-mem.db`. Fully private. Never leaves your machine.

**Can I search my memories?**
Yes. 7 specialized search tools available through Claude.

**Does it work with existing projects?**
Yes. Starts learning immediately when installed.

**What if I want to forget something?**
Delete observations directly from the SQLite database, or start fresh by removing the DB file.

---

## Get Started

```bash
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
/plugin marketplace add .claude-plugin/marketplace.json
/plugin install claude-mem
```

**Give Claude a memory. Transform how you code.**

---

## Learn More

- [Technical Documentation](./CLAUDE.md)
- [GitHub Repository](https://github.com/thedotmack/claude-mem)
- [Report Issues](https://github.com/thedotmack/claude-mem/issues)

**License**: AGPL-3.0
**Version**: 4.1.0
**Author**: Alex Newman ([@thedotmack](https://github.com/thedotmack))
