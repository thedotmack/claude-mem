# Claude-Mem — Company Dossier (Master Application Dataset)

> This is the canonical, reusable source of truth for every accelerator/VC
> application in this folder. Every per-program file pulls from these facts and
> answer snippets. Update a number here once and reuse it everywhere.
>
> **Last verified:** 2026-05-25. Star/fork counts and any metric change daily —
> re-check the live numbers before you hit submit (see the checklist in
> `README.md`).

---

## 1. One-liners (pick by length limit)

- **8 words:** Persistent memory for every AI coding agent.
- **50 chars:** Persistent memory for AI coding agents.
- **One sentence:** Claude-Mem gives AI coding agents persistent, searchable memory across
  sessions — it captures everything the agent does, compresses it with AI, and injects
  the relevant context back into future sessions, automatically.
- **Tweet-length:** Your AI coding agent forgets everything when a session ends. Claude-Mem
  fixes that. Install once, work normally, and your agent remembers your project across
  every session — across Claude Code, Cursor, Codex, Gemini, Copilot and more. 77k+ GitHub
  stars, Apache-2.0.

## 2. Elevator pitch (≈100 words)

Every AI coding agent — Claude Code, Cursor, Copilot, Gemini, Codex — starts every session
with amnesia. The context you built up yesterday is gone. Developers waste hours re-explaining
their codebase, re-discovering decisions, and re-pasting the same context. Claude-Mem solves
this at the harness layer: it hooks into the agent's lifecycle, captures every tool call and
decision, compresses those into structured "observations" with an LLM, and automatically
injects the relevant memories into future sessions. Install once with one command; the
developer does nothing different. It's open-source (Apache-2.0), works across 9+ agents and
28 languages, and has 77k+ GitHub stars in nine months.

## 3. The problem

- AI coding agents are stateless. Every new session is a blank slate — the model has no memory
  of prior sessions, decisions, dead ends, or the shape of your codebase.
- Developers compensate manually: re-explaining architecture, re-pasting context, maintaining
  hand-written `CLAUDE.md`/rules files, and repeating themselves to the agent. This burns time
  and tokens and produces worse output.
- On teams it's worse: knowledge an agent "learned" in one engineer's session never reaches
  the rest of the team. Tacit knowledge evaporates when a session, or an engineer, leaves.
- Existing fixes are partial: bigger context windows are expensive and still reset; native
  "memory" features are shallow, vendor-locked, and don't span tools or teams.

## 4. The solution

Claude-Mem is a persistent memory layer that sits underneath the agent and works automatically:

1. **Capture** — lifecycle hooks observe every tool call (reads, edits, commands, decisions)
   during a session. Zero manual effort from the developer.
2. **Compress** — an asynchronous worker uses the Claude Agent SDK to distill raw activity into
   structured, typed observations (bugfix, decision, architecture, etc.).
3. **Recall** — at the start of the next session, the most relevant observations are injected
   as context. Developers (and the agent) can also search history in natural language via MCP
   tools and a skill, with progressive disclosure to keep token cost low.

The defining property: **"it just works."** Install once, work normally, get memory as a side
effect. No prompt engineering, no manual note-taking, no behavior change.

## 5. What's novel / why it's hard

- **Harness-layer capture, not app-layer.** Claude-Mem hooks the agent's lifecycle rather than
  asking the user to curate memories. Capture is invisible and complete.
- **Compression, not storage.** It doesn't just dump transcripts; it uses an LLM to extract
  durable, typed, searchable observations — and a 3-layer progressive-disclosure search pattern
  that delivers ~10x token savings (index → timeline → fetch details).
- **Cross-agent + cross-language.** One memory layer spanning Claude Code, Cursor, Codex,
  Gemini CLI, Windsurf, OpenCode, OpenClaw, Copilot, Hermes — and 28 human languages.
- **A team-scale substrate already built.** The server architecture (Postgres + BullMQ/Valkey)
  carries a full identity triad (api_key × actor × request) per event, enabling team/org shared
  memory with tenant isolation and a compliance-grade audit chain — the foundation of the
  commercial product.

## 6. Product & technology

- **Stack:** TypeScript, Bun, Node ≥20. SQLite (`bun:sqlite`) for single-user; Postgres +
  BullMQ/Valkey for the multi-tenant server. Chroma for vector embeddings. Express HTTP API.
  React web viewer UI. Built on the Claude Agent SDK and MCP (Model Context Protocol).
- **Architecture:** 5–6 lifecycle hooks → unified worker service (async LLM processing) →
  SQLite/Postgres → FTS5 + vector hybrid search → context injection. Web viewer streams a
  real-time "memory stream" via SSE.
- **Search:** 3-layer MCP workflow — `search` (compact index) → `timeline` (chronological
  context) → `get_observations` (full details for filtered IDs only).
- **Distribution:** one-command install (`npx claude-mem install`), Claude Code plugin
  marketplace, npm SDK, and an OpenClaw gateway installer.
- **Privacy:** `<private>` tags strip sensitive content at the hook (edge) layer before it ever
  reaches storage. Server adds tenant scoping + per-action audit logs.
- **License:** Apache-2.0 (open core).

## 7. Traction (verify live before submitting)

- **GitHub:** 77,854 stars, 6,706 forks (repo created 2025-08-31 → ~9 months). TypeScript.
- **Mind-share:** featured on Trendshift; listed in "Awesome Claude Code"; active Discord
  community; official X account @Claude_Memory.
- **Founder reach:** Alex Newman — 1,612 GitHub followers.
- **Breadth:** supports 9+ agent harnesses and 28 languages; published on npm and the Claude
  Code plugin marketplace.
- **Velocity:** shipping continuously (v13.x), with a multi-tenant team-memory server merged
  and in beta.

> `[FILL IN before submitting]` npm weekly downloads, install/active counts, Discord member
> count, marketplace install count, week-over-week star growth, and any waitlist signups for
> the Pro/team product. These quantitative deltas are what reviewers weight most.

## 8. Market

- **Wedge market:** developers using AI coding agents — one of the fastest-growing software
  categories (Claude Code, Cursor, Copilot, Gemini, Codex, etc.), already millions of users and
  growing fast.
- **Category:** AI agent memory / context infrastructure — a hot, early infra layer.
  Comparables/competitors include Mem0, Supermemory, Zep, Letta (MemGPT), and the native memory
  features inside each coding tool.
- **Expansion:** individual developer memory → team/org shared memory (the substrate is built)
  → a general memory/context layer for *any* agent (CI bots, MCP clients, IDE extensions,
  autonomous agents).
- **Why now:** agentic coding went mainstream in 2025; context windows are still finite and
  expensive; and every vendor's memory is siloed. A neutral, cross-agent, open memory layer is
  the natural infrastructure play, and the hooks/MCP standards to build it only just shipped.

## 9. Business model (open core)

- **Free & open (Apache-2.0):** the full single-user memory engine, CLI, SDKs, MCP tools,
  adapters, and the self-hostable server. This drives adoption and is the top of the funnel.
- **Commercial (Pro / Team / Enterprise — in development):** Magic Recall hosted cloud,
  team/org memory sync, admin dashboard, SSO/SAML/SCIM, enterprise RBAC, audit-log UI,
  DLP/policy engine, premium knowledge agents, managed evals, enterprise observability, and
  SLA/support. Gated by license validation, layered on top of — not replacing — the open core.
- **Monetization motion:** bottom-up developer adoption (free) → team plans (shared memory,
  per-seat) → enterprise (compliance, SSO, audit, support). Classic open-core/PLG.

## 10. Competition & moat

- **Competitors:** Mem0, Supermemory, OpenMemory, Zep, Letta/MemGPT; plus native memory in
  Cursor/Copilot/etc.
- **Differentiation / moat:**
  - **Zero-config harness-layer capture** — competitors mostly expose an API the developer must
    call; Claude-Mem captures automatically.
  - **Cross-agent neutrality** — not locked to one vendor's tool.
  - **Distribution + community** — 77k+ stars and a real install base are a hard-to-copy
    distribution moat.
  - **Team substrate + audit chain** — the compliance-grade, multi-tenant memory layer is the
    enterprise wedge and is already engineered.
  - **Compounding data** — the more an org uses it, the larger and more valuable its private
    memory corpus becomes (switching cost + network effect within a team).

## 11. Founder

**Alex Newman** — founder & creator of Claude-Mem.
- GitHub: [@thedotmack](https://github.com/thedotmack) (1,612 followers, 118 public repos).
- X / Twitter: [@Claude_Memory](https://x.com/Claude_Memory).
- Email: thedotmack@gmail.com.
- Built Claude-Mem from zero to 77k+ stars in ~9 months as the primary author; ships
  continuously and runs the community (Discord, docs, marketplace).

> `[FILL IN]` Full bio, location, prior companies/exits, technical background, why you're
> uniquely suited to this, and co-founder details (or your stance on being a solo founder and
> your hiring plan). See `00-founder-bio.md` for ready-to-paste bio variants — complete the
> placeholders there.

## 12. Vision

Claude-Mem becomes the **memory layer for all AI agents** — the neutral, open substrate that
lets any agent (coding, ops, support, autonomous) remember, share, and build on context across
sessions, tools, people, and time. Start with the developer's own memory, expand to the team's
shared brain, and end as the infrastructure layer every agent plugs into for durable, attributed,
searchable memory.

## 13. Honest risks / things to address (don't volunteer unless asked)

- **Platform dependency:** built closely on the Claude Agent SDK / Claude Code ecosystem.
  Mitigation: already cross-agent (9+ harnesses), neutral MCP-based design.
- **Big-vendor "memory" features:** the coding tools may build native memory. Mitigation:
  neutrality across tools, open ecosystem, team/enterprise depth they won't prioritize.
- **Monetization is early:** pre-revenue; the commercial layer is in development. Frame as
  "massive top-of-funnel adoption proven; now converting to team/enterprise."
- **Solo founder (if applicable):** address hiring plan and any key contributors.
- **$CMEM token:** a community Solana token was created by a third party and publicly embraced
  by the founder. It is **not** the business model or a fundraising vehicle for the company.
  Many institutional VCs view memecoins as a distraction or red flag — recommend **omitting it**
  from VC/accelerator applications unless directly asked, and if asked, framing it strictly as a
  community/marketing phenomenon separate from the cap table and product.

## 14. Quick reference table

| Field | Value |
|---|---|
| Company / project | Claude-Mem |
| Website | https://docs.claude-mem.ai |
| Repo | https://github.com/thedotmack/claude-mem |
| One-liner | Persistent memory for every AI coding agent |
| Founded | 2025 (repo created 2025-08-31) |
| Founder | Alex Newman (@thedotmack) |
| Contact | thedotmack@gmail.com |
| License | Apache-2.0 (open core) |
| Stack | TypeScript, Bun, SQLite/Postgres, Chroma, MCP, Claude Agent SDK |
| GitHub stars | 77,854 (verify live) |
| Forks | 6,706 (verify live) |
| Stage | Pre-seed / open-source with massive adoption, pre-revenue |
| Location | `[FILL IN]` |
| Incorporated? | `[FILL IN — entity type & state]` |
| Raised to date | `[FILL IN — likely $0 / bootstrapped]` |
