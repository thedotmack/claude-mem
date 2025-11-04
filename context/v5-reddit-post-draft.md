# The problem with AI memory isn't storage—it's the research tax

Every time you ask Claude to work on something, there's this invisible token cost you're paying before it even starts: contextualization.

"Fix the auth bug" requires Claude to first figure out:
- What auth system are you using?
- What changed recently?
- What was the last decision about auth?
- Is that info even current, or is it from 3 weeks ago before the refactor?

That research phase? That's your context window disappearing.

## I tried everything

Early in claude-mem's development, I was using ChromaDB for vector search. Semantic matching was great—find conceptually similar stuff across thousands of memories.

But here's what I learned watching the system work in real-time:

Most memories are duplicate knowledge. Your codebase architecture doesn't change every session.

But some memories are **changes**. Bugfixes. Refactors. Decisions.

And if you can't tell which one is the newest change, your information is stale, and Claude has to go researching. Which brings us back to: wasting tokens.

## Vector search alone isn't enough

Semantic search finds relevant documents. But it doesn't know that the "authentication decision" from 3 weeks ago was completely invalidated by yesterday's refactor.

Without temporal ordering, you get:
- 10 memories about your auth system
- No idea which is current
- Claude has to read them all and infer chronology
- Token waste

That's when the hybrid architecture clicked:

**ChromaDB for semantic relevance** (finds conceptually related memories)
↓
**90-day temporal filter** (removes ancient irrelevant stuff)
↓
**SQLite chronological ordering** (newest first)

Now when you search "auth changes," you get a timeline. Not a pile of memories you have to sort through.

## The "instant replay" feature

v5.0 adds something I'm calling timeline-on-demand.

You say: "Work on that feature from 2 weeks ago"

Instead of:
1. Search for "feature"
2. Get 50 results
3. Figure out which one you meant
4. Read context around it
5. Start working

You get:
1. Natural language search finds the anchor point
2. Timeline reconstructs everything around that moment
3. Claude's head is in the game, immediately

## The paradox I didn't expect

Claude-mem's startup context got so good that Claude rarely uses the search tools anymore.

The last 50 observations at session start is usually enough.

But for specific tasks—especially revisiting old work—the timeline feature gives you contextualization-on-demand without burning through your context window on research.

You're paying for focused context, not broad context.

That's the difference.

---

**Repo**: https://github.com/thedotmack/claude-mem

v5.0 just shipped. Python optional but recommended for semantic search. Falls back to keyword search if you don't have it.

Thoughts? Does the "research tax" resonate with anyone else?
