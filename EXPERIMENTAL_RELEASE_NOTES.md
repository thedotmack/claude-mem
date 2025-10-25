# Experimental Release: Progressive Disclosure Context System

## 🧪 Branch: `feature/context-with-observations`

**Status:** Seeking user feedback before merging to main

**We'd love your testing and feedback!** This experimental branch reimagines how Claude-Mem presents context at session startup, using a progressive disclosure approach that could significantly improve Claude's ability to leverage past learnings.

---

## What is Progressive Disclosure?

Progressive disclosure is a **layered memory retrieval system** inspired by how humans remember information:

### Layer 1: Index (The "Table of Contents")
**Frontloaded at session start** - Claude sees:
- **What exists**: Titles of all recent observations and session summaries
- **Retrieval cost**: Token counts for each observation
- **Priority signals**: Type indicators (🔴 critical gotcha, 🟤 architectural decision, 🔵 explanatory)

### Layer 2: Details (On-Demand Retrieval)
**Retrieved via MCP search** - Claude fetches:
- Full observation narratives when deeper context is needed
- Search by concept, file path, type, or keywords
- Only loads what's relevant to the current task

### Layer 3: Perfect Recall (Source of Truth)
**Direct code access** - When needed:
- Read actual source files for implementation details
- Access original transcripts for exact quotes
- Full context without compression artifacts

---

## The Problem This Solves

### Current Version (v4.2.x) Limitation

The current context hook shows **only session summaries** at startup:

```markdown
**Session #312**: Put date/time at end of session titles
Completed: Added date/time to session list with proper formatting
Next Steps: Test edge cases with long dates
```

**Strengths:**
- ✅ Minimal token overhead (~800 tokens)
- ✅ Clean, readable summaries

**Weaknesses:**
- ❌ Claude doesn't know **what** detailed observations exist
- ❌ Can't make informed decisions about whether to search vs read code
- ❌ Often re-reads code to understand decisions that were already documented

### Experimental Version Enhancement

The experimental hook shows an **observation index** alongside session summaries:

```markdown
**src/hooks/context.ts**
| ID | Time | T | Title | Tokens |
|----|------|---|-------|--------|
| #2332 | 1:07 AM | 🔴 | Critical Bugfix: Session ID NULL Constraint | ~201 |
| #2340 | 1:10 AM | 🟠 | Remove Redundant Summary Section | ~280 |
| #2344 | 1:34 AM | 🔵 | Added progressive disclosure usage instructions | ~149 |
```

**Benefits:**
- ✅ Claude knows **what** learnings exist (titles/types)
- ✅ Token counts inform **cost-benefit** decisions (fetch ~200 tokens vs re-read 2000-line file)
- ✅ Progressive disclosure instructions **teach Claude** how to use the system
- ✅ Type indicators help prioritize (critical gotchas > explanatory notes)

**Trade-offs:**
- ⚠️ Higher initial token cost (~2,500 tokens vs ~800)
- ⚠️ More visual noise in the context output
- ❓ Unknown: Does this actually improve Claude's behavior enough to justify the cost?

---

## What's New in This Branch

### 1. Observation Index Display

Full table view of recent observations grouped by file:

```markdown
### Oct 25, 2025

**src/hooks/context.ts**
| ID | Time | T | Title | Tokens |
|----|------|---|-------|--------|
| #2296 | 12:12 AM | 🟢 | Session summaries now display date and time | ~141 |
| #2298 | 12:44 AM | 🔵 | Timeline rendering refactored | ~231 |

**General**
| ID | Time | T | Title | Tokens |
|----|------|---|-------|--------|
| #2301 | 12:50 AM | 🟢 | Development Task Breakdown Created | ~128 |
```

### 2. Token Cost Metadata

Every observation shows estimated token count:
- Helps Claude decide: "Is it worth fetching this 500-token explanation, or should I just read the code?"
- Makes cost-benefit analysis explicit

### 3. Progressive Disclosure Instructions

New guidance section teaches Claude how to use the system:

```markdown
💡 Progressive Disclosure: This index shows WHAT exists (titles) and retrieval COST (token counts).
- Use MCP search tools to fetch full observation details on-demand (Layer 2)
- Prefer searching observations over re-reading code for past decisions and learnings
- Critical types (🔴 gotcha, 🟤 decision, ⚖️ trade-off) often worth fetching immediately
```

### 4. Type-Based Priority System

Observations categorized by importance:
- 🔴 **gotcha** - Critical bugs/blockers (fetch immediately)
- 🟤 **decision** - Architectural choices (high value)
- ⚖️ **trade-off** - Design considerations (prevents re-debating)
- 🟠 **why-it-exists** - Rationale documentation
- 🟡 **problem-solution** - How issues were solved
- 🟣 **discovery** - Important learnings
- 🔵 **how-it-works** - Explanatory/educational
- 🟢 **what-changed** - Implementation details

---

## Testing Instructions

### Option 1: Quick Test (No Installation)

```bash
# Clone and checkout experimental branch
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
git checkout feature/context-with-observations

# Build the experimental version
npm install
npm run build

# Navigate to YOUR project directory
cd /path/to/your/project

# Run the experimental context hook with full path
node /path/to/claude-mem/plugin/scripts/context-hook.js

# Example:
# cd ~/my-app
# node ~/Downloads/claude-mem/plugin/scripts/context-hook.js
```

**Important:** The context hook reads from the current working directory (cwd). You must run it from your project's root folder to see context for that specific project.

This shows you the new context format without installing the plugin.

### Option 2: Full Testing (Install Locally)

If you're already using claude-mem and want to test the experimental version:

```bash
# Navigate to your local claude-mem plugin directory
cd ~/.claude/plugins/marketplaces/thedotmack

# Checkout experimental branch
git fetch origin
git checkout feature/context-with-observations

# Rebuild
npm install
npm run build

# Restart Claude Code to see the new context injection
```

**⚠️ Warning:** This will replace your current context hook. To revert:
```bash
git checkout main
npm run build
```

---

## What We Want to Know

Please test the experimental branch and share your feedback on these questions:

### 1. Behavioral Impact
- ✅ **Does Claude use MCP search more effectively?**
  - Does it fetch observation details more often?
  - Does it make better decisions about when to search vs read code?

### 2. Token Cost Analysis
- 💰 **Do token counts influence Claude's retrieval decisions?**
  - Does Claude reference the token counts when deciding whether to fetch?
  - Example: "This observation is 500 tokens, so I'll read the code instead"

### 3. Instruction Effectiveness
- 📖 **Is the progressive disclosure guidance helpful or noisy?**
  - Does Claude seem to understand the layered retrieval concept?
  - Do the instructions clutter the context or improve clarity?

### 4. Efficiency Gains
- 🚀 **Does it reduce redundant code reading?**
  - Does Claude fetch learnings instead of re-reading entire files?
  - Overall: Is it faster/smarter despite the higher initial token cost?

### 5. User Experience
- 👤 **Is the observation table too cluttered?**
  - Does the table format help or hurt readability?
  - Would you prefer a different presentation?

---

## How to Provide Feedback

### 📣 GitHub Issues (Please Use This!)

**[→ Click here to open a new issue](https://github.com/thedotmack/claude-mem/issues/new)**

Add the label `feedback: progressive-disclosure` and use this template:

```markdown
## Progressive Disclosure Feedback

**Branch tested:** feature/context-with-observations
**Test duration:** [e.g., 2 days, 10 sessions]
**Project type:** [e.g., TypeScript library, React app, Python backend]

### What worked well:
- [Your positive observations]

### What didn't work:
- [Issues or concerns]

### Specific answers:
1. **Claude's MCP search usage:** [Improved/Same/Worse]
2. **Token count influence:** [Yes/No/Unclear]
3. **Instructions helpful:** [Yes/No/Too verbose]
4. **Code reading reduction:** [Yes/No/Hard to tell]
5. **Overall impression:** [Worth merging/Needs work/Not useful]

### Additional notes:
[Any other feedback, screenshots, or examples]
```

**Why issues?** It keeps all feedback in one searchable place and lets other users see what's being discussed. Please don't hesitate to open an issue - all feedback is valuable, positive or negative!

---

## Next Steps

Based on feedback, we'll decide:

### ✅ If Successful:
- Merge to `main` branch
- Release as v4.3.0
- Make progressive disclosure the default
- Potentially add verbosity settings (minimal/standard/detailed)

### ⚠️ If Mixed Results:
- Make it opt-in via settings: `CLAUDE_MEM_VERBOSE_CONTEXT=true`
- Default to current minimal approach
- Allow users to choose their preference

### ❌ If Unsuccessful:
- Keep as experimental branch
- Continue iterating on the approach
- May explore alternative presentation formats

---

## Technical Details

### Files Changed

- **src/hooks/context.ts** (lines 227-240)
  - Added progressive disclosure instructions
  - Enhanced observation table rendering
  - Token count display for each observation

### Token Cost Breakdown

**Current version (v4.2.x):**
- Session summaries only: ~800 tokens
- 3 sessions × ~250 tokens each
- Minimal overhead

**Experimental version:**
- Progressive disclosure instructions: ~150 tokens
- Observation index: ~2,000 tokens
  - 50 observations × ~40 tokens per row
- Session summaries: ~800 tokens
- **Total: ~2,950 tokens**

**ROI Analysis:**
- If this prevents even ONE 2,000-token file read per session, it pays for itself
- If Claude makes smarter retrieval decisions, overall token usage could be lower

---

## Acknowledgments

This experimental feature was inspired by:
- Anthropic's "Effective context engineering for AI agents" (Sept 2025)
- Claude Skills' progressive disclosure architecture (Oct 2025)
- Real-world usage patterns from 200+ GitHub stars in 36 hours

Special thanks to our early adopters for pushing the boundaries of what's possible with persistent memory!

---

## Questions?

- 📖 **Docs:** [docs/](docs/)
- 🐛 **Issues:** [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- 💬 **Discussion:** [GitHub Discussions](https://github.com/thedotmack/claude-mem/discussions)

---

**Happy Testing!** 🧪

We're excited to hear what you discover with progressive disclosure. This could be a game-changer for how Claude leverages long-term memory, but we need your real-world testing to validate the approach.

— Alex Newman ([@thedotmack](https://github.com/thedotmack))
