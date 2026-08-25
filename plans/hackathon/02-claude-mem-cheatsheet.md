# Claude-Mem Cheat Sheet

*Everything you need to know about Claude-Mem on one sheet. No code required. Keep it open while you hack.*

---

## 1. What it is (10 seconds)

**Claude-Mem = a memory layer for AI coding agents.**
A second agent watches your main agent work, writes structured notes about what matters, and hands them back next session. Your agent starts warm instead of cold.

Open source. 100,000+ developers. `github.com/thedotmack/claude-mem`

---

## 2. Why it exists (the three costs of amnesia)

| Without memory | With Claude-Mem |
|---|---|
| Every session starts cold — agent re-reads the codebase | Session opens with a timeline of what happened last time |
| Re-reading = tokens = money | Titles-first recall: huge work compressed into a tiny index (typical startup context reports ~99% savings) |
| "Why did we do it this way?" — nobody wrote it down | Decisions are recorded *with their rationale*, searchable forever |

---

## 3. The two agents

| | Main agent (the builder) | Observer agent (the note-taker) |
|---|---|---|
| **Does** | Reads, edits, runs commands, talks to you | Watches. Writes notes. Never talks to you. |
| **Sees** | Your prompts, the files, the results | *Every tool use* the builder makes, plus its result |
| **Decides** | What to build | **"Is this worth a note?"** — most of the time: no |
| **Speed** | Never waits for the observer | Works in the background |

Key rule: Claude-Mem **observes from outside**. It never changes what the main agent does. If it vanished, the builder would carry on — just with no memory afterward.

---

## 4. How it plugs in (lifecycle moments)

| Moment | What Claude-Mem does |
|---|---|
| **Session starts** | Injects the timeline: recent note titles, IDs, times, category icons. The "warm boot." |
| **After every tool use** | Hands the action + result to the observer → observer decides note / no note |
| **Turn or session ends** | Observer writes a short progress summary: where we are, what's next |

---

## 5. Anatomy of a note ("observation")

Every note has the same shape. Memorize this — it's the heart of the system.

| Field | What it is | Rule of thumb |
|---|---|---|
| **Title** | One line: what happened | Future agent usually reads *only* this. Make it carry the meaning. |
| **Subtitle** | One more line of context | Which part of the system, what situation |
| **Facts** | ~3 **single-sentence bullets** (the "semantic chunks") | Each sentence must make sense *alone*, out of context |
| **Narrative** | A short paragraph: the story, the why | For when you need the full picture |
| **Category (type)** | One label from the mode's list | e.g. bugfix · feature · refactor · change · discovery · decision |
| **Tags (concepts)** | Reusable knowledge labels | e.g. how-it-works · why-it-exists · what-changed · problem-solution · gotcha · pattern · trade-off |
| **Files** | Read / modified | Where to jump to next time |
| **Timestamp** | Automatic | Makes the timeline possible |

Example (plain English):

> 🔴 **bugfix** · 3:48 PM — **Fixed login redirect loop caused by stale session cookie**
> • Loop only happened when the cookie was older than 24h. • Fix clears the cookie before redirecting. • Logic lives in the auth middleware, not the login page.
> *Narrative: looked like a frontend routing bug; cause was server-side.* tags: problem-solution, gotcha

---

## 6. Where notes live

- Local database + meaning-aware search index in **`~/.claude-mem`** on your machine.
- Nothing leaves except calls to the AI model that does the observing.
- Optional: **CMEM Pro** cloud sync across machines (hackers: 30 days free, code **FASTHACK30** at cmem.ai).
- A local **viewer** web page shows notes landing in real time, browsable + searchable.

---

## 7. How notes come back — cheapest first

```
Layer 1  TIMELINE   automatic at session start   titles + IDs only      (cheap, ~hundreds of tokens)
Layer 2  GET BY ID  on demand                    facts + narrative      (pay only for what you need)
Layer 3  SEARCH     when it's older / elsewhere  by meaning, keyword,   (titles first, then fetch)
                                                 category, date, project
```

Mantra: **titles first, details on demand.** Never dump everything.

---

## 8. Modes — the observer's job description (swappable!)

A **mode** is a plain config file that sets:

1. **Who the observer is** (software engineer's scribe? forensic analyst? study partner?)
2. **Note categories** (bugfix/feature/… or entity/relationship/timeline-event/evidence/anomaly/conclusion or action-goal/state-change/error …)
3. **Tags** for the domain
4. **Language** (30+ shipped: `code--es`, `code--ja`, `code--ar`, …)

Same machinery, different job description → observe **anything**:

| Mode idea | What the observer watches for |
|---|---|
| code (default) | bugfixes, features, decisions, discoveries |
| code--chill | only things painful to rediscover |
| email-investigation | people, orgs, relationships, timeline events, anomalies |
| law-study | cases, rules, exam-relevant points |
| meme-tokens | pump signals, trading patterns |
| robot monitoring | goals, state changes, errors |
| **your mode** | whiteboard photos · meeting transcripts · chat logs · support tickets · logs · screenshots |

Make one without writing it by hand: **`/mode-creator`** (interviews you, writes + installs + activates the mode).

**Any data in, any pattern out.**

---

## 9. Building blocks you can build on

| Block | What it gives you |
|---|---|
| **Timeline** | Time-ordered notes with IDs; anchor on one, read around it |
| **Search** | Semantic + keyword, filter by project / category / date |
| **Skills** (CLI-shaped, text in → text out) | mem-search · timeline-report · knowledge-agent · mode-creator · how-it-works · learn-codebase · make-plan / do |
| **Real-time observations** | Notes land *while* the agent works → something can react |
| **Session summaries** | The hand-off note at the end of every session |

---

## 10. Five-minute start

1. `npx claude-mem install`
2. Work in a session (observer starts taking notes)
3. Start a **second** session in the same project → see the timeline at the top. That's memory. *(First session seeds; second is where you feel it.)*
4. Ask "did we already fix X?" → agent uses search
5. Open the viewer, watch notes land
6. `/mode-creator` → point the observer at something that isn't code

---

## 11. The $1,000 Memory Prize — seven directions

1. **Warm boot** — instant context, no ten-turn rediscovery
2. **Build on the timeline** — timeline + search as your retrieval layer
3. **Give the skills a face** — UI/UX so memory is something you can see, steer, share
4. **Build an integration** — editor, CI, chat app, another agent framework
5. **Ingest anything, look for anything** — images, transcripts, logs, tickets + a custom mode
6. **Fire on what it sees** — react to observations in real time
7. **Memory as a speed play** — fewer tokens, turns, seconds

Judged separately from overall 1st–3rd (you can win both). **Extra points for: would someone actually use this?**

---

## 12. Vocabulary (plain English)

- **Observer** — the second agent that takes notes
- **Observation** — one note (title, facts, narrative, category, tags, files, time)
- **Tool use** — one action the main agent takes (read / edit / run / search)
- **Timeline** — the time-ordered list of note titles injected at session start
- **Mode** — the observer's job description (role, categories, tags, language)
- **Skill** — a small reusable helper command the agent can run
- **Session summary** — the end-of-session "where we are / what's next" note
- **Warm boot** — starting a session already knowing what happened
