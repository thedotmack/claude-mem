# The $1,000 Memory Prize — sponsored by Claude-Mem

*Build an agentic tool that actually remembers.*

---

## What Claude-Mem is, in one breath

Claude-Mem is the open-source memory layer for AI coding agents. A second agent watches your primary agent work, turns what happens into structured, timestamped observations, and makes them searchable — so the next session starts warm instead of cold. 100,000+ developers use it.

The mechanism, in plain English: your main agent takes actions — reads a file, edits a file, runs a command. Every one of those actions is handed to a second "observer" agent. The observer asks "is this worth a note?" Most of the time, no. When yes, it writes a structured note: a **title**, a **subtitle**, a few **single-sentence facts** (semantic chunks that stand alone), a short **narrative**, a **category** (bugfix, feature, decision, discovery…), some **tags**, the **files** involved, and a **timestamp**. The notes live in a local, meaning-aware search index. Next session, the titles come back as a timeline; details are fetched by ID only when needed. And the observer's job description — the **mode** — is swappable, so the same machinery can watch code, emails, photos, transcripts, robot logs, anything.

---

## The challenge

**Build an agentic tool that actually remembers.**

Not "an agent with a bigger context window." Not "an agent that stuffs everything into a prompt." An agent — or a tool for agents — that keeps what matters, finds it when it's relevant, and uses it to be faster, smarter, or more useful than it was the last time.

Claude-Mem gives you the memory layer. You build the thing that makes memory *matter*.

---

## Seven directions

Pick one, combine a few, or bring your own.

### 1. Warm boot
An agent that opens with instant context instead of burning its first ten turns rediscovering the codebase. Measure it: how many turns did the cold version need before it was useful? How many does yours need? Show the difference.

### 2. Build on the timeline
Use the timeline and the memory-search skill as your retrieval layer for something new. The timeline is a time-ordered stream of structured notes with IDs — anchor on any one and read what happened around it. Search is semantic and keyword, filterable by project, category, date. What would you build if you had that as your database?

### 3. Give the skills a face
The skills in the repo are CLI-shaped: text in, text out. Wrap them in UI or UX that makes memory something you can **see**, **steer**, or **share**. A dashboard. A browser extension. A mobile view. A way to edit or approve notes. A way to hand your memory to a teammate.

### 4. Build an integration
Wire Claude-Mem into somewhere it doesn't live yet — your editor, your CI pipeline, your chat app, another agent framework or harness. Memory is most valuable where the work already happens.

### 5. Ingest anything, look for anything
Observations aren't text-only — Claude-Mem can take in images too, so screenshots, UI captures, design files and whiteboard photos are fair game alongside transcripts, logs, issues, commit history and support tickets. A custom mode tells the observer what to watch for. Any data in, any pattern out. `/mode-creator` will interview you and write the mode.

### 6. Fire on what it sees
Observations land in real time while your agent works. Hook actions off them: a pattern shows up, something runs. A security note lands → ping the channel. A "decision" observation appears → open a ticket. The same error is observed three times → escalate. Agents that react to what just happened instead of waiting to be asked.

### 7. Memory as a speed play
Use recall to cut tokens, turns, or wall-clock time. The titles-first recall pattern already reports ~99% savings in startup context; push it further, measure it, show the numbers.

---

## The scoring tiebreaker

**Everything scores extra for being something someone would actually use.**

A polished demo of a real need beats a clever demo of an imaginary one. If you'd keep using it Monday morning, you're on the right track.

---

## The prize

**$1,000 cash.** Judged separately from overall 1st–3rd place — so you can win both.

---

## Get set up

- Every hacker gets **30 days of CMEM Pro free**: run `npx claude-mem install`, then use code **FASTHACK30** at cmem.ai.
- Repo and skills: **github.com/thedotmack/claude-mem**
- Fastest way to "get it": install, do one session of work, start a second session, look at the timeline at the top. Then open the viewer and watch notes land live.

---

## Cheat-sheet recap

- **Two agents:** builder does the work; observer takes the notes.
- **Every tool use** goes to the observer; it decides note / no note.
- **A note =** title + subtitle + single-sentence facts + narrative + category + tags + files + time.
- **Recall =** titles first (timeline) → details by ID → search for the rest.
- **Modes =** the observer's swappable job description: code, emails, photos, transcripts, robots, anything.
- **Build on:** timeline · search · skills · real-time observations · session summaries · modes.
