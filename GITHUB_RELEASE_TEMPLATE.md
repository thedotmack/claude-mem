# 🧪 Experimental: Progressive Disclosure Context System

> **We'd love your feedback!** Test the new context injection approach and share your experience.

## What is Progressive Disclosure?

A **layered memory retrieval system** that shows Claude:
1. **Index** (frontloaded): What observations exist + token costs
2. **Details** (on-demand): Full narratives via MCP search
3. **Perfect recall**: Source code when needed

**The idea:** Instead of hiding observations completely, show an index so Claude can make informed decisions about what to fetch.

## Try It Out

```bash
# Clone and build experimental version
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
git checkout feature/context-with-observations
npm install && npm run build

# Navigate to YOUR project and run the hook
cd /path/to/your/project
node /path/to/claude-mem/plugin/scripts/context-hook.js
```

**Important:** Run from your project's root directory to see context for that project.

## What's Different?

**Current (v4.2.x):** Session summaries only (~800 tokens)
```markdown
Session #312: Put date/time at end of session titles
Completed: Added formatting
Next: Test edge cases
```

**Experimental:** Observation index + summaries (~2,500 tokens)
```markdown
**src/hooks/context.ts**
| ID | Time | T | Title | Tokens |
|----|------|---|-------|--------|
| #2332 | 1:07 AM | 🔴 | Critical Bugfix: Session ID NULL | ~201 |
| #2340 | 1:10 AM | 🟠 | Remove Redundant Summary Section | ~280 |
```

Now Claude knows:
- What learnings exist (without loading them)
- Cost to fetch details (~200 tokens)
- Priority (🔴 critical vs 🔵 informational)

## We Want Your Feedback

Test the experimental branch and tell us:

✅ **Does Claude use MCP search more effectively?**
💰 **Do token counts influence retrieval decisions?**
📖 **Are the instructions helpful or noisy?**
🚀 **Does it reduce redundant code reading?**

### 📣 [Please Open a GitHub Issue](https://github.com/thedotmack/claude-mem/issues/new) With Your Experience!

Use the label `feedback: progressive-disclosure` - all feedback is valuable, positive or negative!

## Files Changed

- Updated `README.md` with experimental feature section
- Enhanced `src/hooks/context.ts` with progressive disclosure instructions
- New docs: `EXPERIMENTAL_RELEASE_NOTES.md` (full details)

## Next Steps

Based on your feedback:
- ✅ **If successful:** Merge to main, release as v4.3.0
- ⚠️ **If mixed:** Make opt-in via settings
- ❌ **If unsuccessful:** Keep iterating as experimental

---

**Full details:** See [EXPERIMENTAL_RELEASE_NOTES.md](EXPERIMENTAL_RELEASE_NOTES.md)

**Questions?** Join the discussion or open an issue!
