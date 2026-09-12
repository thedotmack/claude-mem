# Claude-Mem: The Hacker's Field Guide

*A no-code, no-jargon explanation of what Claude-Mem is, why it exists, and how it works — written for hackathon builders who have never seen it before.*

---

## The one-sentence version

Claude-Mem gives your AI coding agent a memory. A second agent sits next to your main agent, watches everything it does, writes down the parts worth remembering, and hands those notes back the next time you start working — so your agent wakes up already knowing what happened yesterday.

That's it. Everything else in this guide is detail.

---

## Part 1 — The problem: AI agents forget everything

Imagine hiring a brilliant engineer. Incredibly fast, knows every language, never gets tired. There's one catch: every morning they arrive with total amnesia. They don't remember the codebase, the bug you fixed together yesterday, the decision you made about the database last week, or the three approaches that already failed.

So every morning starts the same way. They re-read the files. They re-discover the structure. They re-ask the questions you already answered. They sometimes re-try the thing you already proved doesn't work. The first ten or twenty minutes of every single session is spent just getting back to where you were.

That is exactly what working with an AI coding agent feels like today. The agent is brilliant inside a session and a blank slate the moment the session ends.

This has three real costs:

1. **Time.** Every session starts cold. The agent burns its first several turns rediscovering things it already knew yesterday.
2. **Money.** All that rediscovery means re-reading files, which means tokens, which means dollars. A lot of the spend on AI agents is the agent re-learning what it already learned.
3. **Lost decisions.** The worst part isn't the slow start — it's the forgotten reasoning. "Why did we do it this way?" The answer existed once. Nobody wrote it down. Now it's gone.

Claude-Mem exists to fix all three.

---

## Part 2 — The idea: give the agent a note-taker

Here's the core insight, and it's a simple one.

You don't need to make the main agent remember. You just need someone to **take notes while it works**, and to **hand those notes back** at the right moment.

So Claude-Mem adds a second agent. Call it the **observer**. It doesn't write code. It doesn't talk to you. It has exactly one job: watch the main agent work, and keep a running notebook of what's worth remembering.

Think of it like a scribe in the room. Your main agent is the builder — reading files, editing code, running commands, making decisions. The observer is sitting in the corner with a notebook. Every time the builder does something, the observer glances over and asks one question:

> "Is this worth writing down?"

Most of the time the answer is no. Reading a file to check something trivial? No note. Running a quick command that showed nothing interesting? No note. The observer is deliberately selective — a notebook full of trivia is as useless as no notebook at all.

But when the answer is yes — a bug got fixed, a decision got made, something surprising was discovered, a feature shipped — the observer writes a note. A proper, structured note, not a dump of raw text.

And then the next time you sit down to work, the observer opens the notebook and says: "Here's what happened recently. Here's what you were in the middle of. Here's what you decided and why." The builder reads the notes and starts warm.

That is Claude-Mem. Two agents: one does the work, one remembers it.

---

## Part 3 — How the observer sees what's happening

This is the "how does it actually plug in?" question, and the answer is simpler than you'd expect.

When an AI coding agent works, it doesn't do magic — it takes **actions**. It reads a file. It edits a file. It runs a command. It searches for something. Each of these is called a **tool use**. A session is really just a long sequence of tool uses.

Claude-Mem hooks into the moments *around* those actions. The agent's environment (Claude Code, and others) lets outside programs listen for a handful of lifecycle moments:

- **When a session starts.** Claude-Mem uses this moment to hand the notes back — it injects a compact timeline of recent observations into the agent's context so it begins warm.
- **After every single tool use.** Every read, every edit, every command. Claude-Mem catches the action plus its result and passes it to the observer.
- **When the agent finishes a turn / the session ends.** Claude-Mem asks the observer to write a short progress summary — where things stand, what's next.

The important thing: Claude-Mem **never interrupts or changes** what the main agent does. It watches from the outside. If Claude-Mem crashed entirely, the main agent would carry on exactly as before — it just wouldn't remember anything afterward. The main agent is never slowed down waiting for the observer; the note-taking happens in the background.

So the picture looks like this:

```
 Your main agent                      The observer agent
 (does the work)                      (takes the notes)
 ─────────────────                    ───────────────────
 reads a file        ──► handed over ──►  "worth a note? ...no."
 edits a file        ──► handed over ──►  "worth a note? ...no."
 runs the tests      ──► handed over ──►  "worth a note? YES — tests went green
                                           after the config fix."  ✎ writes note
 fixes a bug         ──► handed over ──►  "worth a note? YES."      ✎ writes note
 ...
 session ends        ──► handed over ──►  writes a short summary of the session
```

Every tool use goes to the observer. The observer decides which ones become notes.

---

## Part 4 — What a note actually looks like

The observer doesn't write a diary. It writes **structured notes** — and the structure is what makes them useful later, because structure is what makes notes searchable, skimmable, and cheap to hand back.

Every note (Claude-Mem calls them **observations**) has the same shape:

### 1. A title
One line. What happened, written so that the title alone tells you whether you care. Example: *"Fixed login redirect loop caused by stale session cookie."* The title is the most important field, because most of the time the title is **all** the future agent will read.

### 2. A subtitle
One more line of context. What part of the system, what the situation was.

### 3. Facts — the semantic chunks
Three-ish **single-sentence bullet points**. Each one is a standalone, true statement that makes sense on its own with no surrounding context. These are the "semantic chunks" — small, self-contained pieces of meaning that can be found by search and understood in isolation. Examples:

- *The redirect loop only happened when the session cookie was older than 24 hours.*
- *The fix was to clear the cookie before re-issuing the login redirect.*
- *The relevant logic lives in the auth middleware, not the login page.*

Each fact is one sentence. Each fact could be pulled out and dropped into a totally different conversation and still be useful. That is the test.

### 4. A narrative
A short paragraph telling the story: what was happening, what was tried, what was learned, why it matters. This is the "for when you need the full picture" field. The facts are for skimming; the narrative is for understanding.

### 5. A category (the note's type)
One label from a fixed list, so the notebook can be filtered and color-coded. In the default code mode the categories are things like:

- **bugfix** — something was broken, now it's fixed
- **feature** — new capability added
- **refactor** — restructured, behavior unchanged
- **change** — generic modification (docs, config, misc)
- **discovery** — learned something about the existing system
- **decision** — an architectural or design choice, with the rationale

(Plus a few security-related ones.) The category answers "what kind of thing is this?" at a glance.

### 6. Tags (concepts)
A handful of reusable labels describing what *kind of knowledge* is in the note, independent of the specific topic. In code mode these are things like *how-it-works*, *why-it-exists*, *what-changed*, *problem-solution*, *gotcha*, *pattern*, *trade-off*. Tags are what let you later ask "show me every gotcha we've hit in this project."

### 7. Files touched
Which files were read, which were changed. This lets the future agent jump straight to the right place.

### 8. A timestamp (automatic)
Every note knows exactly when it happened, which is what makes the **timeline** possible — you can look at any note and ask "what happened right before and after this?"

Put together, one note looks roughly like this (in plain English, not the real format):

> **bugfix** · 3:48 PM
> **Fixed login redirect loop caused by stale session cookie**
> *Auth middleware in the web app*
> - The redirect loop only happened when the session cookie was older than 24 hours.
> - The fix clears the cookie before re-issuing the login redirect.
> - The logic lives in the auth middleware, not the login page.
>
> Users reported getting bounced between /login and /dashboard forever. Tracing it showed the middleware was trusting a cookie that the server had already expired. Clearing it before redirecting broke the loop. Worth remembering because the symptom looks like a frontend routing bug but the cause is server-side.
>
> tags: problem-solution, gotcha · files: middleware/auth.ts

Title, facts, narrative, category, tags, files, time. Every note. Same shape. That consistency is the whole trick.

---

## Part 5 — Where the notes live, and how they come back

### Where they live
On your machine. Claude-Mem stores every observation in a local database in your home folder (`~/.claude-mem`), alongside a search index that understands meaning — not just exact words — so you can search for "that cookie thing" and find the redirect-loop note. Nothing leaves your machine except the calls to the AI model doing the observing. (There's an optional Pro tier with cloud sync if you want the same memory across machines — it's optional.)

### How they come back — the cheap way first
This is the part that makes Claude-Mem practical rather than just nice. If it handed the agent *every note in full* at the start of every session, it would blow the budget instantly. Instead it uses layers, cheapest first:

**Layer 1 — The timeline (automatic, every session).**
When a session starts, Claude-Mem injects a compact list: ID, time, category icon, title. Just titles. Fifty recent notes might cost a few hundred tokens. The agent skims the titles and usually that's enough — "oh right, we fixed the cookie thing yesterday."

**Layer 2 — Fetch by ID (on demand).**
If a title looks relevant and the agent wants the details, it asks for that specific note by its ID and gets the facts, narrative, and files. Only pays for what it actually needs.

**Layer 3 — Search (when it's not in the timeline).**
For anything older, or on a different topic, the agent can search the whole history — by meaning, by keyword, by category, by date, by project. Search returns titles first; the agent filters, then fetches details for the interesting ones. Same cheap-first discipline.

This "titles first, details on demand" pattern is why the startup context you see from Claude-Mem says things like *"50 observations, 17,530 tokens to read, 1.3 million tokens of work behind them, 99% savings."* The notes are a compressed index of a huge amount of work, and the agent only unpacks the parts it needs.

### The viewer
There's also a little local web page where you, the human, can watch the notes land in real time as your agent works, browse by project, and search. It's the easiest way to *see* memory happening.

---

## Part 6 — Modes: telling the observer what to watch for

So far, everything above has assumed the observer is watching a coding session. That's the default. But here's the part that opens up the most creative room:

**The observer's job description is swappable.**

Claude-Mem calls a job description a **mode**. A mode is a plain configuration file that defines four things:

1. **Who the observer is.** "You are a software engineer's note-taker" versus "You are a forensic analyst reviewing emails" versus "You are a law student's study partner."
2. **What the note categories are.** Code mode has bugfix / feature / decision. An email-investigation mode has entity / relationship / timeline-event / evidence / anomaly / conclusion. A robot-monitoring mode has action-goal / state-change / error. Whatever makes sense for the domain.
3. **What the tags are.** The reusable concept labels, tailored to the domain.
4. **What language to write in.** Thirty-plus languages ship out of the box — the same code mode, writing its notes in Japanese or Spanish or Arabic.

That's all a mode is. Swap the mode, and the same machinery — the same second agent, the same watch-every-action loop, the same title/facts/narrative/category/tags note shape — now observes something completely different.

### What that unlocks

Because the observer just watches "actions and their results," and actions can be *anything the agent does*, the thing being observed does not have to be code:

- **A photo.** Your agent opens a whiteboard photo or a screenshot. The observer sees it. With a mode that says "record design decisions and open questions you see on whiteboards," you get structured notes out of a picture.
- **A meeting transcript.** Feed in a transcript; a mode that says "record decisions, owners, and deadlines" turns an hour of talking into a handful of searchable notes.
- **A conversation or chat log.** A support thread, a Slack export, an email dump — a mode tuned for entities and relationships and timeline events turns it into an investigable timeline.
- **Logs, issues, commit history, support tickets.** Anything your agent can read, the observer can take notes on, and the mode decides what "worth noting" means.

Modes that already exist in the repo and in the wild include code (default), a calmer code variant that only records things painful to rediscover, email investigation, law study, meme-token trading signals, and a robot-monitoring mode — which gives you a sense of the range.

And you don't have to hand-write one. There's a `/mode-creator` skill that interviews you — what are you observing, what kinds of things matter, what should the categories be — and writes, installs, and activates the mode for you.

**Any data in, any pattern out.** Pick what to watch. Tell the observer what matters. Get structured, timestamped, searchable notes.

---

## Part 7 — The things you can build on top

Because all the pieces are simple and exposed, they make good building blocks:

- **The timeline** — a time-ordered stream of structured notes with IDs. Anchor on any note and read what happened around it.
- **Search** — semantic and keyword search across every note ever taken, filterable by project, category, date.
- **The skills** — small command-line-shaped helpers in the repo: search memory, generate a timeline report ("the journey of this project"), build a focused knowledge base from observations, create a mode, explain how it works. They're text-in, text-out, which means they're easy to wrap in a UI, an editor, a chat bot, a CI job.
- **Real-time observations** — notes land *while the agent works*, not after. That means something can react to them: a pattern appears → a thing runs.
- **Session summaries** — at the end of every session the observer writes a short "here's where we are, here's what's next," which is the hand-off to the next session.

---

## Part 8 — Why this matters (the honest pitch)

AI agents are about to do a lot of the world's work. Right now, every one of them wakes up with amnesia. Whatever fixes that is going to matter a lot.

Claude-Mem's bet is that the fix isn't one giant model that somehow remembers everything. The fix is boring and robust: **a second agent, a notebook, a consistent note shape, and a cheap-first way of handing notes back.** It's the kind of thing that works today, costs very little, and composes with everything else.

Over 100,000 developers already use it. It's open source. And the pieces are small enough that one person, in one weekend, can build something genuinely new on top of them.

---

## Part 9 — Getting started in five minutes

1. Install: `npx claude-mem install`
2. Start a coding session and do some work. The observer starts taking notes immediately.
3. Start a *second* session in the same project. Look at the top — you'll see the timeline: the titles of what happened last time. That's memory injection. (The first session seeds memory; the second is where you feel it.)
4. Ask your agent "did we already fix X?" — it'll use the search skill.
5. Open the local viewer and watch notes land while you work.
6. Run `/mode-creator` and point the observer at something that isn't code.

Every hacker gets 30 days of CMEM Pro free: install, then use code **FASTHACK30** at cmem.ai.

Repo and skills: **github.com/thedotmack/claude-mem**

---

## Part 10 — The $1,000 Memory Prize

Sponsored by Claude-Mem. Judged separately from overall 1st–3rd, so you can win both.

**The challenge: build an agentic tool that actually remembers.**

Seven directions — pick one, combine a few, or bring your own:

1. **Warm boot.** An agent that opens with instant context instead of burning its first ten turns rediscovering the codebase.
2. **Build on the timeline.** Use the timeline and the search skill as your retrieval layer for something new.
3. **Give the skills a face.** The skills are CLI-shaped. Wrap them in UI or UX that makes memory something you can see, steer, or share.
4. **Build an integration.** Wire Claude-Mem into somewhere it doesn't live yet — your editor, your CI, your chat app, another agent framework or harness.
5. **Ingest anything, look for anything.** Observations aren't text-only — screenshots, UI captures, design files, whiteboard photos, transcripts, logs, issues, commit history, support tickets. A custom mode tells the observer what to watch for. Any data in, any pattern out.
6. **Fire on what it sees.** Observations land in real time. Hook actions off them: a pattern shows up, something runs. Agents that react to what just happened instead of waiting to be asked.
7. **Memory as a speed play.** Use recall to cut tokens, turns, or wall-clock time.

And finally: everything scores extra for being something someone would actually use.

---

## The whole thing on one card

- **What:** a memory layer for AI agents.
- **How:** a second "observer" agent is handed every tool use and decides whether to take a note.
- **A note is:** title + subtitle + single-sentence facts + narrative + category + tags + files + time.
- **Notes come back:** titles first (cheap), details by ID, search for the rest.
- **Modes:** swap the observer's job description — observe code, emails, photos, transcripts, robots, anything.
- **Build on:** timeline, search, skills, real-time observations, session summaries.
- **Prize:** $1,000 for an agentic tool that actually remembers. Seven directions. Extra points for "someone would actually use this."
