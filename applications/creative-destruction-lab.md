# Creative Destruction Lab (CDL) — Application

- **Portal:** https://creativedestructionlab.com/apply/ (@creativedlab)
- **Profile:** objectives-based, equity-free, no-fee program for massively scalable,
  science-/tech-based ventures. 23 streams across multiple sites. Mentor-driven; you set and
  hit 90-day objectives across 5 sessions.
- **Source of facts:** `00-company-dossier.md`. Verify live numbers before submit.

> CDL is mentor/objective-driven and takes equity-free — it's about coachability and a
> defensible, scalable technology. Emphasize the technical substrate, measurable objectives, and
> why this is a category-defining infrastructure play.

---

## Venture overview

- **Venture:** Claude-Mem
- **Website / repo:** https://docs.claude-mem.ai · https://github.com/thedotmack/claude-mem
- **One-line description:** A persistent, searchable memory layer for AI agents.
- **Stream fit:** AI / developer infrastructure (map to the most relevant CDL stream, e.g. an AI
  or software stream). `[FILL IN: chosen stream + site preference.]`
- **Stage:** Open-source product with 77k+ GitHub stars; pre-revenue; commercial team/enterprise
  layer in development.

## Describe your venture

Claude-Mem is a persistent memory layer for AI coding agents and, increasingly, any AI agent. AI
agents are stateless — they forget everything between sessions — so developers and teams lose
context, decisions, and hard-won knowledge constantly. Claude-Mem captures agent activity at the
harness layer, compresses it into structured observations using an LLM, and injects relevant
memories into future sessions automatically. It works across 9+ agent harnesses and 28 languages,
is open-source (Apache-2.0), and includes a multi-tenant server for team/org shared memory with a
compliance-grade audit chain.

## What is the defensible technology / what's hard about it?

- **Harness-layer capture:** invisible, complete capture via lifecycle hooks — not an API the
  user must call. Requires deep integration across many agent runtimes.
- **AI compression + progressive disclosure:** distilling raw activity into typed, searchable
  observations and a 3-layer retrieval pattern (~10x token savings).
- **Multi-tenant memory substrate:** Postgres + queue-backed generation with a full per-event
  identity triad (api_key × actor × request) and audit logs — the basis for team/enterprise and
  for trustworthy, attributable AI memory.
- **Distribution moat:** 77k+ stars and an active install base are hard to replicate.

## Market & scalability

Wedge: developers using AI coding agents (millions, fast-growing). Expansion: team/org shared
memory, then a general agent-memory infrastructure layer. The AI-agent-memory category (Mem0,
Supermemory, Zep, Letta) is forming now; massively scalable as a software/infra layer with
PLG + enterprise motion.

## Traction & validation

- 77,854 GitHub stars, 6,706 forks in ~9 months, zero paid marketing.
- Trendshift feature; "Awesome Claude Code" listing; active Discord.
- Distributed via npx, plugin marketplace, npm; shipping continuously (v13.x).
- `[FILL IN: downloads, active installs, community size, growth rates, any design partners.]`

## Proposed 90-day objectives (CDL is objective-driven — make these measurable)

`[FILL IN / refine — examples:]`
1. Ship the commercial team product (shared memory + billing) and onboard `[N]` paying teams.
2. Reach `[X]` weekly active installs / `[Y]` npm weekly downloads (measurable growth target).
3. Sign `[N]` enterprise design partners for SSO/audit/compliance features.
4. Hire `[role(s)]` to support the commercial motion.
5. Define pricing and validate willingness-to-pay with `[N]` customer conversations.

## Team

Alex Newman — founder, creator, primary author; built the full technical stack solo. `[FILL IN:
technical credibility, founder-market fit from 00-founder-bio.md, advisors, hiring plan.]`

## Why CDL?

`[FILL IN: which CDL mentors/site, what coaching you want (commercialization of open-source infra,
enterprise GTM, fundraising), and why equity-free objective-based mentorship fits your stage.]`

## Business model

Open-core: free Apache-2.0 core for adoption; revenue from team plans and enterprise (SSO/SAML/
SCIM, RBAC, audit-log UI, DLP, hosted cloud, SLA). See `00-company-dossier.md` §9.
