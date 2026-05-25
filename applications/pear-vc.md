# Pear VC — PearX Application

- **Portal:** https://pear.vc/pearx/ (apply via the PearX page)
- **Cadence:** 2 batches/year, in person in SF. The post notes S26 kicks off July.
- **Profile:** seed-stage; Pear backs very early, technical founders and is hands-on.
- **Source of facts:** `00-company-dossier.md`. Verify live numbers before submit.

> Pear weighs founder quality, a real wedge, and early signal. Be concrete about traction and
> the path from open-source adoption to revenue.

---

## Company basics

- **Company:** Claude-Mem
- **Website / repo:** https://docs.claude-mem.ai · https://github.com/thedotmack/claude-mem
- **One-liner:** Persistent memory for every AI coding agent.
- **Location:** `[FILL IN]`
- **Stage:** Pre-seed; open-source with massive adoption, pre-revenue.
- **Founder:** Alex Newman (thedotmack@gmail.com)

## What does your company do?

Claude-Mem is a persistent memory layer for AI coding agents. AI agents like Claude Code,
Cursor, and Copilot start every session with no memory of the last one, so developers constantly
re-explain their codebase and re-paste context. Claude-Mem hooks into the agent's lifecycle,
captures everything it does, compresses that into structured observations with an LLM, and
injects the relevant context into future sessions — automatically, with zero behavior change.
It's open-source (Apache-2.0) and runs across 9+ agents and 28 languages.

## What's the problem and why now?

AI coding agents went mainstream in 2025, but they're stateless: context resets every session.
Developers burn hours and tokens compensating manually. Bigger context windows are expensive and
still reset; native memory is shallow and vendor-locked. Now is the moment because (1) agentic
coding adoption is exploding, (2) the hook/MCP standards needed to build a neutral memory layer
just shipped, and (3) no one owns the cross-agent, open memory layer yet. The first credible,
widely-adopted one wins the category.

## Why is this a big opportunity?

Wedge: developers using AI coding agents — already millions, growing fast. Expansion: from one
developer's memory → a team's shared memory (substrate already built) → the memory/context layer
for *every* agent (coding, ops, autonomous). If agents are the new default interface, durable
memory underneath them is infrastructure-scale. The AI-agent-memory category (Mem0, Supermemory,
Zep, Letta) is forming right now; we have the distribution lead.

## Traction

- 77,854 GitHub stars, 6,706 forks in ~9 months (created Aug 2025), zero paid marketing.
- Featured on Trendshift; listed in "Awesome Claude Code"; active Discord community.
- Distributed via one-command `npx` install, the Claude Code plugin marketplace, and npm.
- Shipping continuously (v13.x); multi-tenant team-memory server merged and in beta.
- `[FILL IN: npm weekly downloads, install/active users, Discord size, WoW growth, any team/
  enterprise waitlist or design partners.]`

## Business model & path to revenue

Open-core. Free OSS core fuels bottom-up adoption; revenue from team plans (shared memory, per
seat) and enterprise (SSO/SAML/SCIM, RBAC, audit-log UI, DLP, hosted Magic Recall cloud, SLA).
The team substrate (multi-tenant Postgres + audit chain) is engineered; commercial packaging is
the next milestone. `[FILL IN: pricing hypothesis and first paid milestone.]`

## Competition / why you win

Mem0, Supermemory, Zep, Letta, plus native memory inside coding tools. We win on (1) zero-config
harness-layer capture vs. API-you-must-call competitors, (2) cross-agent neutrality vs. siloed
native memory, (3) a distribution moat of 77k+ stars, and (4) a built team/enterprise substrate
with compliance-grade audit. Private team memory corpora compound — switching cost grows with use.

## Team

Alex Newman — founder, creator, primary author; built the full stack solo (hooks → worker →
multi-tenant server → search → UI) and runs the community. `[FILL IN: founder-market-fit story
from 00-founder-bio.md; co-founders or hiring plan; why you're the person to build this.]`

## What do you need from Pear / why PearX?

`[FILL IN: be specific — e.g., go-to-market for the team/enterprise product, first commercial
hires, enterprise design-partner intros, and seed financing to convert massive OSS adoption into
revenue. Mention Pear's hands-on, technical-founder support if it fits.]`

## How much are you raising / use of funds?

`[FILL IN — target round size and the milestones it buys: e.g., 12–18 months to ship the team
product, land N paying teams, and validate enterprise.]`
