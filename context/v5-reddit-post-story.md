# Your Claude forgets everything after /clear. Mine doesn't.

You know the cycle.

/init to learn your codebase. Takes a few minutes. Claude reads everything, understands your architecture, builds context.

You work for a while. Context window fills up. You try /compact to compress the conversation—but you can't recall specific moments later, and the compressed format is more verbose than useful.

Eventually you hit /clear.

Everything's gone.

Next session: Claude reads CLAUDE.md again. Does the research again. Re-learns your codebase again.

Tokens cost money. 

Research takes time. 

Low context windows cause quality issues. 

Claude forgets.

This cycle is killing productivity.

## Designing instant memory recall that survives /clear

I spent months building persistent memory for Claude Code. Not summaries. Not compressed conversations. Actual persistent memory—capture everything Claude does, process it with AI, make it instantly recallable across sessions.

/clear doesn't delete anything. The memory persists.

Early on I tried all kinds of vector stores, MCPs, memory tools. I was using ChromaDB for vector search.

The documents were big massive things. Great performance in a RAG sense—semantic matching worked. But it would use up context too quickly.

Either I was doing it wrong, or vector databases are just limited in what they can do.

That's how I ended up with the hybrid approach.

## Watching memories get saved live

The entire idea behind "temporal context" came to me as I watched memories being captured in real-time.

I could see that most memories were duplicate knowledge. Your codebase architecture doesn't fundamentally change every session.

But many memories were **changes**. Bugfixes. Refactors. Decisions.

And here's the thing: if you don't have the date and time associated with it, if you don't know it's the "newest" change, then your information is stale.

And if your information is stale, Claude has to go researching.

Researching is the token-heavy work I'm trying to minimize.

## Building v4.0 with timelines in mind

When I was designing claude-mem 4.0 to be a plugin architecture compatible with Claude Code 2.0, I decided to focus on the SQLite database and observation formatting first.

The semantic chunking was architected by design so it could be brought into ChromaDB later for the best possible results.

But then using the super-fast SQLite index to sort results by date, so you could search for "change" or "bugfix" and see a timeline.

Newest first. So you know what's current.

## Bringing ChromaDB back

Then I brought ChromaDB back to compare with FTS5 searching.

Chroma returned very relevant results with vector relations. FTS5 just doesn't work as well for semantic matching.

And it was fast. Really fast.

That's when the custom timeline feature clicked.

## The "instant replay" idea

My thought was: what if you ask Claude to work on a task from 3 days ago, 4 weeks ago?

Now you have an "instant replay" of everything that was done around whatever you're searching for.

Natural language search finds the anchor point. Timeline reconstructs the context around that moment. Claude's head is in the game, immediately.

## The paradox

Here's what actually happened.

Claude-mem's startup context got so good that Claude rarely even uses the search tools anymore.

The last 50 observations at session start is usually enough for whatever I'm working on. /clear doesn't reset anything—next session starts exactly where you left off.

But I just built out contextualization-on-demand for v5.0. When you need to recall something specific from weeks ago, the "context timeline" instantly gets Claude's head in the game for that exact task.

No /init. No research phase. No re-learning.

Just: start session, Claude knows your codebase, you work.

Development becomes pleasant instead of repetitive. Token-efficient instead of wasteful. Focused instead of constantly re-explaining.

---

**Repo**: https://github.com/thedotmack/claude-mem

v5.0 just shipped. Python optional but recommended for semantic search. Falls back to keyword search if you don't have it.

Does the "how to work on this task" problem resonate with anyone else?
