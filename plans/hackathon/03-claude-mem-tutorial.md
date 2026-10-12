# Claude-Mem Tutorial: From Zero to "It Remembers" in One Sitting

*A step-by-step walkthrough for hackathon builders. No prior knowledge needed. Every step tells you what to do, what you'll see, and what it means.*

---

## Before you start

You need an AI coding agent that Claude-Mem can plug into (Claude Code is the main one; there are integrations for others), a terminal, and about fifteen minutes. That's it. Claude-Mem installs the rest of what it needs on its own.

A quick mental model before we touch anything: Claude-Mem is a **second agent that watches your first agent and takes notes**. We're going to install it, watch it take notes, see the notes come back, search them, and then change what it watches for. Five stages.

---

## Stage 1 — Install (2 minutes)

**Do this:**

```
npx claude-mem install
```

**What you'll see:** The installer sets up the plugin and a small background service, and checks that the two helpers it relies on (a fast JavaScript runtime and a Python tool manager for the search index) are present — installing them if not.

**What it means:** From now on, every coding session in this agent is being observed. You haven't changed anything about how your agent works. You've just put a note-taker in the room.

---

## Stage 2 — Your first observed session (5 minutes)

**Do this:** Start a normal coding session in any project. Do a few real things — read a couple of files, make a small edit, run a command, fix something. Ask the agent to explain part of the code to you.

**What you'll see:** Nothing different. That's the point. The main agent behaves exactly as before.

**Behind the scenes:** Every action the agent took — every read, edit, command — was handed to the observer. For each one the observer asked "worth a note?" and for the interesting ones, it wrote one: a title, a subtitle, a few single-sentence facts, a short narrative, a category (bugfix / feature / discovery / decision / …), some tags, and the files involved.

**Optional — watch it happen live:** Open the local viewer in your browser (the install output tells you the address). Keep it on a second screen while you work and you'll see notes appear in real time as the agent acts. This is the single best way to *get* what Claude-Mem is doing.

---

## Stage 3 — The warm boot: see memory come back (2 minutes)

**Do this:** End the session. Start a **new** session in the **same** project.

**What you'll see:** At the top of the new session, before you've typed anything, a compact block like this:

```
# [claude-mem] recent context
Mode: Code Development (code)

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision

ID      TIME   TYPE  TITLE
110958  12:21p 🟣    Created shared attribution module with centralised constants
110962  12:27p 🔵    Merge conflict in mcp-server when combining two branches
110969  12:30p 🟣    Branch passes full test suite: 2685 pass, 0 fail
...
Stats: 50 obs (17,530t read) | 1,324,849t work | 99% savings
```

**What it means:** That's the **timeline** — the titles of what happened recently, each with an ID. The agent reads it in a glance. The stats line is the whole value proposition in one row: fifty notes, about seventeen thousand tokens to read, representing over a million tokens of actual work. The agent now knows what happened last time for roughly 1% of the cost of redoing it.

The first session in a project seeds memory. The second is where you feel it.

**Try this:** Ask the agent, in plain language, about something you did last session. "What did we change in the auth flow earlier?" Watch it answer from the timeline — or fetch the note's details by ID if it needs more.

---

## Stage 4 — Search the past (3 minutes)

The timeline only shows recent notes. Everything older is still there — you just have to ask.

**Do this:** Ask a "did we already…" question. "Did we already fix the redirect loop?" "How did we set up the test database last week?" "What did we decide about caching?"

**What you'll see:** The agent uses the memory-search skill. It follows a three-step pattern you'll recognize everywhere in Claude-Mem:

1. **Search** → get back a table of titles with IDs (cheap)
2. **Timeline** around an interesting result → what happened right before and after it
3. **Fetch by ID** → the full facts + narrative for just the notes that matter

**What it means:** The agent never dumps the whole notebook into context. It skims titles, narrows, then reads only what it needs. That discipline — titles first, details on demand — is why memory stays cheap as the notebook grows.

**You can search too:** the viewer has a search box. Try searching for a *concept* rather than an exact phrase ("that cookie thing") — the index understands meaning, not just words.

---

## Stage 5 — Change what the observer watches for (5 minutes)

Everything so far assumed the observer was watching code. Now let's point it at something else.

**The idea:** The observer's job description is a **mode** — a plain config file that sets who the observer is, what note categories exist, what tags exist, and what language to write in. Swap the mode and the same machinery observes something completely different.

**Do this:**

```
/mode-creator
```

**What you'll see:** An interview. It asks what you're observing (a codebase? email dumps? meeting transcripts? whiteboard photos? robot telemetry?), what kinds of things matter, and what the categories should be. Then it writes the mode file, installs it into `~/.claude-mem/modes/`, activates it, restarts the background service, and shows you the new mode name in your startup context.

**Try one of these:**

- **Whiteboard photos.** Mode: "You're an architect's assistant. Record design decisions, open questions, and owners you see on whiteboards." Then have your agent open a photo of a whiteboard. Watch the notes.
- **A meeting transcript.** Mode: "Record decisions, action items with owners, and deadlines." Paste or open a transcript. Watch the notes.
- **A conversation / chat export.** Mode modeled on email-investigation: entities, relationships, timeline events, anomalies. Open the export. Watch the notes.

**What it means:** Anything your agent can read, the observer can take notes on — and the mode decides what "worth a note" means. Any data in, any pattern out.

**Modes that already exist for inspiration:** code (default), code--chill (only the painful-to-rediscover stuff), 30+ language variants, email-investigation, law-study, meme-tokens, and a robot-monitoring mode someone built for their own project.

---

## Stage 6 — What to build on (reading, not doing)

Now that you've felt the loop, here are the handles you can grab for your hack:

- **Timeline** — time-ordered notes with IDs. Anchor on one, read around it. Use it as a retrieval layer.
- **Search** — semantic + keyword, filter by project / category / date.
- **Skills** — small text-in/text-out helpers in the repo (mem-search, timeline-report, knowledge-agent, mode-creator, how-it-works, learn-codebase, make-plan/do). CLI-shaped means easy to wrap in a UI, an editor, a chat app, a CI job.
- **Real-time observations** — notes land while the agent works. A pattern appears → something runs.
- **Session summaries** — the end-of-session "where we are / what's next" hand-off.
- **Modes** — custom observer job descriptions for any data type.

And the seven prize directions map straight onto these: warm boot · build on the timeline · give the skills a face · build an integration · ingest anything · fire on what it sees · memory as a speed play.

---

## Troubleshooting in one breath

- **Don't see the timeline?** It starts on your *second* session in a project. (Or run `/learn-codebase` to front-load a repo in one pass.)
- **Want to confirm what mode is active?** It's the `Mode:` line at the top of the startup context.
- **Want to see notes live?** Open the viewer.
- **Where's the data?** `~/.claude-mem` on your machine. Uninstall removes it cleanly.

---

## Recap

1. Install → a note-taker joins the room.
2. Work → every action is handed to the observer; the interesting ones become structured notes.
3. New session → the timeline comes back: titles first, ~99% cheaper than redoing the work.
4. Ask "did we already…" → search, timeline, fetch-by-ID.
5. `/mode-creator` → point the observer at photos, transcripts, conversations, anything.
6. Build on timeline / search / skills / real-time notes / summaries / modes.

Hackers get 30 days of CMEM Pro free: install, then code **FASTHACK30** at cmem.ai. Repo: **github.com/thedotmack/claude-mem**.
