# Y Combinator — Summer 2026 (S26) Application

- **Portal:** https://www.ycombinator.com/apply
- **Deadline:** extended to **May 25th** (apply this weekend). S26 batch context.
- **Format:** online form + a 1-minute founder video (record after drafting).
- **Source of facts:** `00-company-dossier.md`. Verify live star/metric numbers before submit.

> YC values: clear thinking, real traction, and founders who ship. Keep answers blunt,
> specific, and number-driven. Drop adjectives; lead with evidence. Edit my `[FILL IN]`s.

---

## Company

**Company name:** Claude-Mem

**Company URL:** https://github.com/thedotmack/claude-mem (docs: https://docs.claude-mem.ai)

**Demo video / product:** `[FILL IN: link to a 1–2 min screen recording of install → memory
recall. The README GIF (docs/public/cm-preview.gif) is a starting point.]`

**What is your company going to make? (one sentence)**
Claude-Mem is a persistent memory layer for AI coding agents — it automatically captures what
the agent does, compresses it with AI, and injects the relevant context back into future
sessions, so the agent stops forgetting your project.

**Describe what your company does in 50 characters or less.**
Persistent memory for AI coding agents.

---

## The idea

**Why did you pick this idea to work on? Do you have domain expertise? How do you know people
need what you're making?**
Every AI coding agent starts each session with total amnesia — the context you built yesterday
is gone, so you re-explain your codebase, re-paste decisions, and repeat yourself constantly. I
live in these tools daily and felt the pain acutely, so I built the fix at the harness layer
(hooks), where capture can be invisible and complete. People need it: with zero paid marketing,
Claude-Mem hit 77k+ GitHub stars and 6.7k+ forks in nine months, was featured on Trendshift,
and developers run it across 9+ agent harnesses. `[FILL IN: your specific domain expertise —
prior infra/dev-tools work that proves you can build and ship this.]`

**What's new about what you're making? What substitutes do people resort to?**
New: capture at the harness/lifecycle layer (not an API the user has to call), AI *compression*
into typed, searchable observations (not raw transcript dumps), and a token-efficient 3-layer
progressive-disclosure search (~10x token savings). Substitutes today: bigger/more expensive
context windows that still reset; hand-maintained `CLAUDE.md`/rules files; copy-pasting context
every session; or shallow, vendor-locked native "memory." None work across tools or teams; we
do, across 9+ agents and 28 languages, open-source.

**Who are your competitors, and who might become competitors? Who do you fear most?**
Direct: Mem0, Supermemory, Zep, Letta/MemGPT. Potential: native memory built into Cursor,
Copilot, Claude Code, etc. We fear the platform vendors most — but their memory will be siloed
to their own tool, while our wedge is cross-agent neutrality, an open ecosystem, and team/
enterprise depth (shared memory + compliance-grade audit) that single-tool vendors won't
prioritize. Distribution (77k+ stars) is a real head start.

---

## Progress

**How far along are you?**
Live and widely used. v13.x shipping continuously; 77k+ stars, 6.7k+ forks; published on npm
and the Claude Code plugin marketplace; one-command install. The single-user product is mature.
A multi-tenant team-memory server (Postgres + BullMQ/Valkey, full per-event identity triad and
audit chain) is merged and in beta — the foundation of the paid product.

**How long have you been working on this? How many full-time, part-time?**
Since August 2025 (~9 months). `[FILL IN: full-time/part-time, team size — and if solo, say so
plus your hiring plan.]`

**Are people using your product? How many active users/customers? Are you growing? How much?**
Yes — distributed via npx, the plugin marketplace, and npm, with an active Discord community.
`[FILL IN — CRITICAL: npm weekly downloads, install/active counts, marketplace installs,
week-over-week star and download growth. YC weighs this most; put real numbers here.]`

**Do you have revenue? How much?**
Pre-revenue. The open-source core drives adoption (top of funnel); the commercial layer
(hosted Magic Recall cloud, team memory sync, SSO/RBAC, audit UI, enterprise) is in development.
`[FILL IN: any waitlist, design-partner, or LOI signal for the team/enterprise product.]`

**If you've applied or been part of YC before, how has it changed since?**
`[FILL IN — likely "N/A, first time applying" or note prior progress.]`

---

## Tech & business

**Tech stack:** TypeScript, Bun, Node ≥20. SQLite (single-user) → Postgres + BullMQ/Valkey
(multi-tenant server). Chroma vector DB for semantic search; FTS5 for keyword. Express HTTP API,
React viewer UI. Built on the Claude Agent SDK and MCP.

**How will you make money? How big could the company be?**
Open-core PLG: free OSS core drives bottom-up adoption → paid team plans (shared memory, per
seat) → enterprise (SSO/SAML/SCIM, RBAC, audit-log UI, DLP, managed cloud, SLA). The wedge is
the fastest-growing developer category (AI coding agents, already millions of users); the
expansion is the memory/context layer for *every* agent. If agents are the new default
interface, the durable memory layer underneath them is infrastructure-scale.

**Where do you live now, and where would the company be based after YC?**
`[FILL IN — current location; YC expects in-person in the Bay Area during the batch.]`

---

## Founders

**Founder(s) and roles:** Alex Newman — founder, creator, primary author. `[FILL IN: co-founders
if any; if solo, state it and your plan to hire.]`

**Founder bio (paste from `00-founder-bio.md`, ~100-word version, with your `[FILL IN]`s done).**

**How do the founders know each other / how long?** `[FILL IN, or N/A if solo.]`

**Who writes code, or does other technical work? Did any of you take an unusual route to
where you are now?** Alex builds the product end-to-end (hooks, worker, multi-tenant server,
search, UI). `[FILL IN: unusual-route story — YC loves these.]`

---

## Equity & legal

- **Have you incorporated?** `[FILL IN]`
- **Cap table / prior funding:** `[FILL IN — likely none/bootstrapped]`
- **Equity split among founders:** `[FILL IN]`

---

## Anything else / what do you understand that others don't?

We understand that **memory, not model size, is the next bottleneck for agents** — and that the
right place to solve it is the harness layer, invisibly, so adoption requires zero behavior
change. We've proven the demand (77k+ stars, no paid marketing) and already built the team-scale
substrate that turns a beloved dev tool into enterprise infrastructure. The hard part — earning
millions of developers' trust to sit underneath their agents — is the part we've already started
winning.

---

## 1-minute founder video — script (record after editing)

> YC asks for a ~1 minute video of the founder(s) talking to the camera. Be natural, fast, and
> specific. Rough script (~150 words ≈ 60s):

"Hi YC, I'm Alex Newman, founder of Claude-Mem. Every AI coding agent — Claude Code, Cursor,
Copilot — forgets everything the moment a session ends. So developers waste hours every week
re-explaining their own codebase to the agent. Claude-Mem fixes that. You install it with one
command, you work normally, and it quietly captures everything the agent does, compresses it
with AI, and feeds the right context back into your next session. The agent just... remembers.
I shipped it nine months ago. With zero paid marketing it's at 77,000+ GitHub stars, it works
across nine different coding agents, and I've already built the multi-tenant server for team
and enterprise memory — which is how we make money. Memory, not model size, is the next
bottleneck for AI agents, and we're the open layer everyone's already installing. `[FILL IN:
one sentence on why you're the person to build this.]` Thanks for watching."
