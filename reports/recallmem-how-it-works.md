# How RecallMEM Works: A Memory the Model Can't Fake

*A codebase walkthrough of [RealChrisSean/RecallMEM](https://github.com/RealChrisSean/RecallMEM) (v0.2.3), written after reading every source file. Prepared with Claude-Mem's `learn-codebase` skill as the source document for a WOWerpoint deck.*

---

## 1. The problem RecallMEM is trying to solve

Every chatbot has the same quiet flaw: it forgets you the moment the tab closes. ChatGPT and Claude.ai have bolted "memory" features on, but in those products the language model itself is in charge of remembering. The model decides what to save, the model decides what to look up, and the model is the one rummaging through your history. That's a problem, because the one thing language models are famously bad at is remembering accurately. They hallucinate. They retrieve the wrong thing on a bad run. Worst of all, they can produce a *false* memory: a confident, personal-sounding detail you never actually said.

RecallMEM is a personal AI chat app that flips that arrangement around. Its one-line philosophy is printed all over the codebase:

> **The LLM proposes, TypeScript decides.**

The model is allowed to *suggest* things worth remembering. It is never allowed to write to the database, and it is never allowed to decide what gets pulled back out. Plain TypeScript code and plain SQL do both of those jobs. The result is a memory system that is predictable, inspectable, and — in the words of the project's own blog draft — "harder to fake."

RecallMEM runs on your own machine. You start it with one command (`npx recallmem`), it opens at `localhost:1337`, and all of your memory lives in a local Postgres database. You can chat with a cloud model (Claude, GPT, Grok, or anything that speaks the OpenAI API format) or with a local Gemma 4 model running in Ollama for complete privacy. The memory works the same either way.

## 2. The building blocks

Before walking through what happens when you send a message, it helps to know the pieces on the table.

- **Next.js 16 app.** One project holds both the chat interface (React pages) and the server (API routes). Everything server-side lives in a `lib/` folder that is deliberately written like a reusable framework.
- **Postgres 17 with pgvector.** pgvector is a Postgres extension that stores "embeddings" — lists of numbers that represent the meaning of a piece of text — and can quickly find the ones closest in meaning to a search. All tables are prefixed `s2m_`, a leftover from the project's earlier name, "speak2me."
- **Ollama.** A local program that runs AI models on your laptop. RecallMEM uses it for two things: Gemma 4 as an optional chat model, and **EmbeddingGemma**, a small model that turns text into 768-number embeddings. EmbeddingGemma is the only model the installer always downloads, because memory search depends on it.
- **Cloud providers (optional).** Anthropic's Messages API, OpenAI's Responses API, and any "OpenAI-compatible" endpoint (Groq, OpenRouter, xAI, LM Studio, and so on). If you add an OpenAI key, embeddings switch to OpenAI's cheaper 256-number `text-embedding-3-small` model, stored in a separate column so the two kinds never get mixed.
- **Deepgram (optional).** Powers the live voice agent, speech-to-text, and text-to-speech.

The database schema grew through fourteen numbered migration files. The important tables are: chats (full transcripts), facts (individual memories), profiles (one summary per user), transcript chunks (embedded slices of old conversations), brains (separate memory spaces), wiki sources/documents/chunks, providers (saved API keys), settings, and a usage log for cost tracking.

## 3. Three layers of memory

RecallMEM doesn't keep one kind of memory. It keeps three, each doing a different job.

**Layer 1 — The profile.** A compact "who am I talking to" summary that goes into every single conversation. Interestingly, despite being called "synthesized," the profile is *not* written by an AI. The function `buildProfileFromFacts` simply takes all active facts, groups them under headings (IDENTITY, FAMILY, WORK, FINANCE, HEALTH, INTERESTS, PROJECTS, SOCIAL, PREFERENCES, OTHER), stamps each with the date it became true, and caps each heading (25 identity facts, 20 work facts, and so on) so it can't grow forever. Because it's built by code, the profile can never contain something that isn't already a fact.

**Layer 2 — Facts.** Short, standalone statements like "User works at Acme" or "User is learning Rust." Each fact is its own database row with a category, a date it became true (`valid_from`), a date it stopped being true (`valid_to`), a status, and — crucially — the exact quote from your conversation that proves it. You can see, edit, confirm, dispute, retire, or delete every one of them.

**Layer 3 — Recalled conversation chunks.** Old conversations are sliced into roughly 1,000-character pieces and embedded. When you mention something, RecallMEM can pull back the relevant passage from a chat three weeks ago, even if it never became a tidy fact. Every recalled chunk is labeled with the date of the conversation it came from, so the model can tell history from the present.

On top of those three layers sit your **custom rules** — a free-text "RULES.md" page where you write standing instructions ("Don't add disclaimers," "Pick one option and tell me why"). Rules are injected into every conversation and override the default behavior.

## 4. The read path: what happens before the model sees your message

When you hit send, the request goes to `/api/chat`. Before any AI is called, the server builds a system prompt entirely with deterministic code. This is the heart of the "TypeScript decides" idea, so it's worth walking through slowly.

1. **Safety caps first.** The route rejects absurd payloads: more than 2,000 messages, more than a million characters, or more than 20 images. Without these, a single request could run up a huge bill.
2. **Four lookups in parallel.** `buildMemoryAwareSystemPrompt` fetches, all at once: your profile, a smart selection of facts, the time of your last conversation, and your custom rules.
3. **Smart fact selection.** `getSmartFacts` fills up to 150 slots in a fixed priority order:
   - First, up to 30 **pinned** facts from the identity and family categories. Who you are is always included.
   - Then, up to 50 facts **relevant to your message**, found by hybrid search (explained below). Exact keyword matches are kept automatically; meaning-based matches are only kept if they're genuinely close (a distance under 0.65).
   - Finally, the **most recent** facts fill whatever room is left.
   - Duplicates are removed by ID, so nothing appears twice.
4. **Recalled chunks, with a deadline.** The server searches old transcript chunks for up to 8 matches, but gives the search only **3 seconds**. If the embedding model is slow or down, the chat continues without recalled chunks instead of hanging.
5. **Date stamps everywhere.** Every fact becomes a line like `- [2026-03-12] User works at Acme`. Every chunk is headed `[from conversation on 2026-03-12]`. The prompt explicitly tells the model that newer facts override older ones.
6. **Template assembly.** `buildSystemPrompt` stitches it all into labeled sections — role, user rules, current time, profile, recent facts, recalled memories, and a short list of behavior rules such as "NEVER guess names, dates, or specific facts." Each section has a character limit (profile 8,000; recalled memories 5,000; rules 4,000).

Only *then* does the chat model get called. It cannot query the database. It cannot choose what to retrieve. It can't "remember" something that isn't already sitting in the prompt it was handed. And because the prompt is assembled by ordinary code, you can trace exactly which facts and passages went into any answer.

### Hybrid search: meaning plus exact words

Early versions searched memory only by meaning (vector similarity). That's great for "what was that voice thing we were building?" but bad for exact strings like a model ID (`grok-4.20-0309-reasoning`), a branch name, an error message, or a price. Those aren't "vibes" — they either match or they don't.

So every memory search now runs two queries and merges them:

- **Keyword search** uses Postgres full-text search plus a literal "contains" match. Special characters like `%` and `_` are escaped so a search stays literal. Trigram indexes keep these substring lookups fast. If your search text appears inside a fact's supporting quote, the result is tagged as a **receipt** match.
- **Semantic search** embeds your message and finds the closest stored embeddings using pgvector's cosine distance.

Keyword hits go first, semantic hits fill in behind, and duplicates are dropped. Each result carries a `match_reason` — `keyword`, `receipt`, or `semantic` — so later code can treat exact hits as trustworthy and hold vaguer semantic hits to a stricter bar. If the embedding service fails entirely, keyword results still come back.

### Keeping long chats cheap

Two more tricks happen in the chat route before the model is called:

- **Sliding window.** If a conversation has more than 10 messages, only the last 5 back-and-forth exchanges are sent in full. Older parts of *the same* chat are searched by meaning, and up to 3 close matches are inserted as an "earlier in this conversation" note. Token use stays flat no matter how long you talk.
- **Resume marker.** If you come back to a chat more than two hours later, a one-line system note is inserted — for example, `[Conversation resumed 6 days later, on 2026-05-23.]` — so the model knows time has passed.

### Private mode and web search

A lock icon in the header turns on **private mode**. In private mode, none of your memory — no profile, no facts, no recalled chunks — is sent to the model. Only your rules and the current message go out, and nothing from that conversation is extracted into memory afterward.

**Web search** is opt-in per message. Claude uses Anthropic's built-in web search tool. Every other provider (including local Gemma) uses the Brave Search API: RecallMEM runs the search itself and pastes the results above the system prompt. If the Brave key is missing or the monthly credits are used up, the model is told exactly that, so it can explain to you instead of silently answering without results. The first time you enable it for a local model, a privacy notice explains that Brave will see your message text but nothing from memory.

## 5. Streaming the answer back

The response streams to your browser as Server-Sent Events (a simple way for a server to push text in small pieces). A few details show how much real-world use shaped this code:

- The very first event carries the chat ID so the browser can track the conversation immediately.
- **Every 3 seconds during streaming**, the partial answer is saved to the database. If you refresh mid-answer, you keep what was written.
- When the stream finishes, the server logs real token counts and estimated cost, saves the full chat, embeds the exchange (if OpenAI embeddings are on), and generates a chat title — all *before* closing the stream, because Next.js stops background work the moment a response closes.
- On the browser side, text is revealed with an adaptive "typewriter" effect that speeds up when it falls behind, and the page backs up the conversation to local storage every five seconds as an emergency safety net, with a `/api/chat/recover` endpoint to restore it.

## 6. The write path: how a memory is born

This is where RecallMEM is strictest. After every assistant reply, a background job — `extractFactsLive` — kicks off without making you wait.

### Step 1: Pick a cheap model

`getCheapestLLM` chooses the extraction model in a fixed order: Claude Haiku 4.5 if you have an Anthropic key, otherwise GPT-5.6 Luna, otherwise Grok 3 Mini, otherwise local Gemma 4 E4B (free). The choice is cached for 60 seconds.

### Step 2: Look only at the latest exchange

Live extraction reads only your last message and the reply — about 2,000 tokens instead of the whole transcript — which keeps it fast and cheap. Your existing active facts (up to 200, each with its ID) are sent along so the model can spot contradictions.

### Step 3: The model proposes, with receipts

The extraction prompt tells the model the **conversation date** and asks for a JSON object. Each proposed fact must come with an exact quote from the transcript:

```json
{"facts": [{
  "text": "User lives in Example City",
  "quote": "I live in Example City",
  "supersedes": ["uuid-of-an-old-fact"]
}]}
```

The prompt's rule, in four words: **"No quote, no memory."** If something is time-relative ("my job starts in 1 month"), the model has to convert it into a real date using the conversation date ("User said on 2030-01-15 that their job starts around 2030-02-15"). If an old fact is no longer true, the model lists that fact's ID under `supersedes`.

### Step 4: TypeScript checks every claim

`validateExtractedFactCandidates` then puts each proposal through a series of gates. Fail any one and the proposal is silently dropped:

1. **Shape check.** It must be an object with both a fact and a quote. Bare strings — the old format — are rejected because they carry no evidence.
2. **Garbage filter.** Regular expressions reject the classic AI junk: "User asked about…", "AI suggested…", "not mentioned", "had a good conversation", and anything under 10 characters.
3. **Time check.** If the fact uses relative time words ("today," "next week," "currently," "in 3 months") but contains no concrete date, it is rejected. A stale "starts in 1 month" gets *worse* every morning, so the code would rather miss a memory than store a misleading one.
4. **Receipt check.** The quote is normalized (lowercased, whitespace collapsed) and must literally appear in the transcript. Quotes shorter than 8 characters don't count, because they'd match by accident. If the model invents "I collect antique maps" and you never said it, the fact dies here.
5. **Supersession check.** Any "this replaces fact X" ID must be a real ID, and must belong to one of your currently active facts. Made-up IDs are thrown away.

As the project's blog draft puts it: *"The model can still hallucinate. It just cannot make the database believe it."*

### Step 5: Decide what's trusted right away

Surviving facts go to `storeFactProposals`, which does three more deterministic things:

- **Deduplication.** A case-insensitive comparison against all active and pending facts (and within the batch) drops repeats.
- **Categorization by keyword, not AI.** The category is picked by matching keyword lists in TypeScript. "wife," "son," "dog" mean family; "job," "hired," "client" mean work; and so on. The matcher handles word forms (work / works / worked / working) while respecting word boundaries, so "son" doesn't match "Sonnet" and "work" doesn't match "framework" — both real bugs that now have regression tests.
- **A review policy.** This is the newest layer. A fact goes straight to **active** only if it's low-risk. It goes to **pending** — visible in your review inbox but *not* used in conversations — if either:
  - it falls in a sensitive category (identity, family, finance, or health), or
  - it would replace an existing memory.

All inserts happen inside one database transaction. Replacement suggestions are stored in a separate proposals table; the old fact keeps working until *you* confirm the change.

### Step 6: Refresh the profile

If any fact became active, every active fact is re-categorized (cheap — no AI involved) and the profile is rebuilt from scratch, so the very next message already knows the new information.

### The bigger pass when you click "New chat"

Clicking **New chat** (or switching chats or brains) calls `/api/chat/finalize`, which waits while the browser shows "Saving memory…". This fuller pipeline generates a title if needed, runs the same extraction over the *whole* transcript (if it has at least 4 messages and 200 characters), rebuilds the profile, and re-embeds the whole conversation into searchable chunks. Closing the tab triggers a best-effort version of the same call. The project originally ran this in the background but hit a race condition where the next chat started before the memories were saved, so it's now deliberate and visible.

## 7. You are the final authority: the Memory page

The Memory page is organized into three tabs:

- **Review** — pending claims waiting for you. Each shows why it needs review ("Sensitive memory requires your confirmation" or "This claim would replace an existing memory"), what it would replace, and its **receipt**: the exact quote that justified it. You can **Confirm** or **Dispute**.
- **Active** — what the assistant actually uses, grouped by category, with the generated profile at the top. You can edit any fact (which marks it as user-written and clears the AI receipt) or **Retire** it.
- **History** — retired and disputed claims, which you can **Restore** or permanently delete.

Every action goes through `reviewFact`, which locks the row, checks the move is legal (you can't "confirm" an already-active fact), and updates everything in one transaction. Confirming a replacement retires the old fact, stamps its end date, and links it to its successor. Restoring an old fact retires whatever had replaced it. History is preserved rather than overwritten, so the database always knows both what's true now and what *used* to be true.

At the bottom sits a danger zone: **Wipe memory** deletes all facts, chunks, and the profile, and **Delete everything** also removes all chats (you have to type DELETE). Both run Postgres's `VACUUM FULL` and `CHECKPOINT` afterward, which physically rewrites the tables so deleted data can't be recovered from the database files.

## 8. Multiple brains

A **brain** is a separate memory space — "work," "personal," "demo," and so on — chosen from a picker in the sidebar. The way it works is simple and clever: the active brain is stored in a browser cookie, and `getUserId()` appends it to your user ID (`local-user::work`). Every chat, fact, profile, and chunk query is automatically scoped to that brain.

Some things are deliberately shared across all brains through `getBaseUserId()`: your API keys, your settings, and your custom rules. You add your Claude key once and every brain can use it. Chat lookups check ownership across all of your brains, which fixed a real bug where switching brains mid-chat silently lost messages, while still stopping anyone from opening a chat just by guessing its ID.

The same two hooks — `configureDb()` and `setUserIdResolver()` — are how a developer would embed RecallMEM's `lib/` folder into their own multi-user app. Swap in your own auth, and every function becomes per-user.

## 9. Wiki mode: answers that must cite their sources

Next to Chat in the mode switcher are **Wiki** and **Study Mode**. These turn a brain into a source-grounded documentation assistant that answers *only* from material you've added.

**Adding sources.** You can paste text, upload a file, or import a public GitHub repo. Repo import makes a shallow clone, walks up to 120 text files (Markdown, code, config) under 220 KB each, skips folders like `node_modules`, and records the exact commit hash. Each file is split into chunks of about 1,400 characters that break at Markdown headings and remember their exact **line ranges**. Content hashes mean re-importing an unchanged file does nothing.

**Answering a question.**
1. Hybrid search finds the top 8 chunks in the brain. If nothing matches, the answer is simply: *"I don't have that in this brain's sources."* — and no AI is even called.
2. The model receives the chunks and must reply with strict JSON: an answer plus citations that name a chunk ID, a line range, and an exact quote.
3. `validateWikiCitations` checks every citation: the chunk must exist, the line range must sit inside that chunk, and the quote must appear in those lines. Bad citations are discarded.
4. If no valid citation survives, RecallMEM refuses to show an unverified answer. It either says the information isn't in the sources (when the matches were weak) or falls back to showing the raw excerpts it found, clearly labeled.
5. For GitHub sources, each citation becomes a link to the exact file, commit, and line numbers on GitHub.

**Study Mode** uses the same machinery, but asks the model to teach Socratically, opening with a probing question before the source-grounded explanation.

## 10. The live voice agent

RecallMEM can also hold a real-time spoken conversation through Deepgram's Voice Agent. The design keeps Deepgram in charge of the audio loop while RecallMEM stays in charge of memory.

- **Safe credentials.** Your permanent Deepgram key never reaches the browser. The server requests a 5-minute temporary token and hands that over instead. (It falls back to the key only if your Deepgram key isn't allowed to issue temporary tokens.)
- **Only fast models.** Local Gemma is blocked as too slow for live conversation, and only "instant" cloud models that Deepgram currently supports are allowed. RecallMEM checks Deepgram's live model list and falls back to a bundled list if that check fails.
- **A short starting prompt.** The voice prompt is kept compact: up to 20 facts (10 pinned), a trimmed profile, the last 4 messages, plus speaking style and pronunciation notes (it tells the agent to say "pgvector" as "pee gee vector").
- **Memory-aware hearing.** Names, project titles, and model IDs pulled from your memory are passed to Deepgram's Flux speech recognizer as "keyterms" (up to 80), so it's more likely to transcribe them correctly. Private mode turns this off.
- **Memory as a tool.** The agent gets one tool, `search_memory`, for questions about you or past decisions. That endpoint returns keyword and receipt matches immediately, and only includes meaning-based matches if they finish within 900 milliseconds. If the lookup takes longer than 450 ms, the agent says "Let me check your memory for that," so there's no dead air. In Wiki or Study mode the only tool is `query_wiki`, and personal memory is never touched.
- **Backup chains.** If the chosen model fails mid-call, Deepgram automatically falls back to GPT-5.6 Luna or Claude Haiku 4.5; if the chosen voice fails, a second Aura-2 voice takes over.
- **Same memory pipeline.** Each finished voice turn is saved as an ordinary chat message through `/api/voice-agent/save`, which then runs the same live fact extraction as text chat. Talk or type — it's one memory. Wiki and Study voice sessions skip extraction.

## 11. Everything else that makes it a real product

- **One-command install.** `npx recallmem` runs a tiny CLI with zero npm dependencies (about 22 KB) that detects one of three situations: you're inside a RecallMEM checkout (developer mode with hot reload), you already have `~/.recallmem` (just start), or it's your first run (clone the repo). On a Mac it offers to install Postgres 17, pgvector, and Ollama via Homebrew with a single yes/no question, creates the database, runs migrations, pulls EmbeddingGemma, writes `.env.local`, builds the app, and opens your browser. `doctor` diagnoses problems; `upgrade` pulls new code and runs new migrations.
- **Models.** A model picker lists local Gemma 4 sizes (E2B, E4B, 26B mixture-of-experts, 31B) with in-app download progress, plus curated cloud models with their prices and reasoning modes (GPT-5.6 Instant/Thinking/Deep/Max; Claude adaptive effort low through max).
- **Files and vision.** Images are shrunk in the browser to save tokens. PDFs have their text extracted *and* every page (up to 20) rendered as an image, so the model can see charts and scanned pages.
- **Voice in normal chat.** Dictate with Deepgram Nova-3 streaming or a local Whisper server; hear replies via Deepgram Aura-2, xAI Grok, OpenAI, or your browser's built-in voice.
- **Usage tracking.** Every model call, speech request, and transcription is logged with an estimated cost and shown on the Settings page by day, week, month, or custom range.
- **Security hardening.** API keys are encrypted at rest with AES-256-GCM using a key file the app creates with locked-down permissions. Cloud provider URLs pass an SSRF guard (blocking internal network addresses like the cloud metadata endpoint at 169.254.169.254), with an exception only for local Ollama. The self-update button only works from localhost. Gitleaks secret scanning runs in git hooks and GitHub Actions, and a path guard refuses to commit database dumps, `.env` files, or personal notes.
- **Observability for developers.** An optional Langfuse integration traces every chat turn — memory build, generation, extraction — and costs nothing if it isn't installed.
- **Tests.** A Vitest suite covers the deterministic rules that matter most: receipt checks, temporal grounding, keyword categorization (including the "Sonnet" and "framework" regressions), the review policy, hybrid search fallbacks, wiki citation validation, encryption, the SSRF guard, and voice-agent configuration.

## 12. Honest rough edges

Reading every file also surfaces places where the documentation and the code have drifted apart — normal for a fast-moving, one-person project:

- The architecture doc says extraction "always uses the local model," but `getCheapestLLM` now prefers a cheap cloud model when you have a key.
- The README describes a "6-step validator"; the code has since added the receipt check, temporal grounding, and the review inbox.
- The profile is described as "synthesized," but it's built by grouping facts in code, with no AI involved (arguably a strength).
- CONTRIBUTING.md says there's no test suite; there is one now.
- The "Connections" panel for Gmail, Notion, and Calendar is a visual preview behind a "Coming Soon" overlay.
- The roadmap still lists stronger links from retired facts to their replacements, a memory evaluation suite, and entity memory (linking people, projects, and places).

## 13. The big idea, in one picture

Strip away the features and RecallMEM is a single, consistent stance repeated at every layer:

| Where | What the model does | What code does |
|---|---|---|
| Reading memory | Nothing — it's handed a finished prompt | SQL + vector search + a TypeScript template |
| Proposing a fact | Suggests text, a quote, and replacements | Checks shape, junk, dates, quote, and IDs |
| Storing a fact | Nothing | Dedupes, categorizes by keyword, applies review policy |
| Replacing a fact | Suggests which old fact is stale | Holds it as a proposal until you confirm |
| Wiki answers | Writes an answer with citations | Verifies every chunk, line range, and quote |
| Voice | Decides when to call `search_memory` | Runs the search with a strict time budget |

The model is treated as a talented but unreliable witness. It's allowed to speak, but every claim it makes about you has to come with a receipt, a date, and — for anything sensitive — your signature. Missing a memory is annoying. Storing a false one is worse. RecallMEM is built, line by line, around that trade.
