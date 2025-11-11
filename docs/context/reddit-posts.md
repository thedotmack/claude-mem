# I built a context management plugin and it CHANGED MY LIFE

Okay so I know this sounds clickbait-y but genuinely: if you've ever spent 20 minutes re-explaining your project architecture to Claude because you started a new chat, this might actually save your sanity.

The actual problem I was trying to solve:

Claude Code is incredible for building stuff, but it has the memory of a goldfish. Every new session I'd be like "okay so remember we're using Express for the API and SQLite for storage and—" and Claude's like "I have never seen this codebase in my life."

What I built:

A plugin that automatically captures everything Claude does during your coding sessions, compresses it with AI (using Claude itself lol), and injects relevant context back into future sessions.

So instead of explaining your project every time, you just... start coding. Claude already knows what happened yesterday.

How it actually works:

Hooks into Claude's tool system and watches everything (file reads, edits, bash commands, etc.)

Background worker processes observations into compressed summaries

When you start a new session, last 10 summaries get auto-injected

Built-in search tools let Claude query its own memory ("what did we decide about auth?")

Runs locally on SQLite + PM2, your code never leaves your machine

Real talk:

I made this because I was building a different project and kept hitting the context limit, then having to restart and re-teach Claude the entire architecture. It was driving me insane. Now Claude just... remembers. It's wild.

Link: https://github.com/thedotmack/claude-mem (AGPL-3.0 licensed)

It is set up to use Claude Code's new plugin system, type the following to install, then restart Claude Code.

/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
Would love feedback from anyone actually building real projects with Claude Code, if this helps you continue, if it helps you save tokens and get more use out of Claude Code. Thanks in advance!

===============================================================================

# How is Claude-Mem different from Claude's New Memory Tool?

A few people have been asking this question on the claude-mem thread I posted yesterday, so I wanted to put up a definitive answer for people, that really explains the differences and how they can be complimentary to each other actually. I used the "claude code docs agent" to help figure this out:

---

Based on the documentation, here are the key differences between your Claude-Mem tool and Claude's official memory tool:

Scope and Architecture
Claude's Memory Tool is designed for single-session memory management within conversations (1). It provides commands like view, create, str_replace, insert, delete, and rename for managing memory files during a conversation (1). The tool automatically includes this instruction: "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE" (1).

Your Claude-Mem is a comprehensive multi-session persistence system that captures context across different Claude Code sessions. It uses hooks to automatically capture tool usage, process observations through the Claude Agent SDK, and restore context when new sessions start.

Memory Persistence
Claude's Memory Tool focuses on within-session memory management. It helps Claude maintain context during a single conversation by reading and writing to memory files (1).

Your Claude-Mem provides cross-session persistence by:

Capturing every tool execution through PostToolUse hooks (2)

Processing observations through the Claude Agent SDK (3)

Automatically injecting summaries from the last few sessions into new session contexts

Using SQLite with FTS5 full-text search for retrieval

Integration Method
Claude's Memory Tool is a built-in tool that works through the standard tool use interface (1).

Your Claude-Mem integrates as a Claude Code plugin using multiple hooks:

SessionStart for context injection (2)

UserPromptSubmit for session initialization (2)

PostToolUse for observation capture (2)

Stop for summary generation (2)

SessionEnd for cleanup (2)

Search and Retrieval
Claude's Memory Tool provides basic file operations for memory management (1).

Your Claude-Mem includes an MCP server with 6 specialized search tools:

search_observations - Full-text search across observations

search_sessions - Search across session summaries

find_by_concept - Find by tagged concepts

find_by_file - Find by file paths

find_by_type - Find by observation type

advanced_search - Combined search with filters

Use Cases
Claude's Memory Tool is ideal for maintaining context within a single conversation, helping with tasks that require remembering information throughout the session (1).

Your Claude-Mem addresses the broader challenge of maintaining project knowledge across multiple Claude Code sessions, essentially solving the session isolation problem that can occur in Claude Code (4).

Your tool appears to be complementary to Claude's memory tool rather than directly competing - it operates at the session level while Claude's memory tool operates within conversations.

===============================================================================

# Hot take... "You're absolutely right!" is a bug, not a feature

When Claude first started saying "You're absolutely right!" I started instructing it to "never tell me I'm absolutely right" because most of the time, it didn't do any verification or thinking before deeming my suggestion "The absolutely right one"

Now we're many versions later, and the team at Claude have embraced "You're absolutely right!" as a "cute" addition to their overall brand, fully accepting this clear anti-pattern.

Is Claude just "smarter" now? Do you perceive "You're absolutely right!" as being given the "absolute right" solution, or are do you feel as though you need to clarify or follow up when this happens?

One of the foundations of my theory behind priming context with claude-mem is this:

"The less Claude has to keep track of that's unrelated to the task at hand, the better Claude will perform that task."

The system I designed uses a parallel instance to manage the memory flow, it's receiving data as it comes in, but the Claude instance you're working with doesn't have any instructions for storing memories. It doesn't need it. That's all handled in the background.

This decoupling matters because every instruction you give Claude is cognitive overhead.

When you load up context with "remember to store this" or "track that observation" or "don't forget to summarize," you're polluting the workspace. Claude has to juggle your actual task AND the meta-task of managing its own memory.

That's when you get lazy agreement.

I've noticed that when Claude's context window gets cluttered with unrelated instructions, this pattern of lazy agreement shows up more and more.

Agreeing with you is easier than deep analysis when the context is already maxed out.

"You're absolutely right!" becomes the path of least resistance.

When Claude can focus purely on your code, your architecture, your question - without memory management instructions competing for attention - it accomplishes tasks faster and more accurately.

The difference is measurable.

The "You're absolutely right!" reflex drops off noticeably because there's room in the context window for actual analysis instead of performative agreement.

What do you think? Does this bother you as much as it does me? 😭
