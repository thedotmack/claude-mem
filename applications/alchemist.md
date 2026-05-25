# Alchemist Accelerator — Application

- **Portal:** https://alchemistaccelerator.com/apply (@AlchemistAcc)
- **Profile:** the enterprise/B2B accelerator. SF, 2 batches/year. Selects almost exclusively
  for startups whose **revenue comes from enterprises** (sell-to-business, not consumer).
- **Source of facts:** `00-company-dossier.md`. Verify live numbers before submit.

> Alchemist screens hard on "is this B2B/enterprise?" Frame Claude-Mem around the team/enterprise
> product and the path to enterprise revenue, not the consumer-dev OSS tool alone. Be candid that
> revenue is forthcoming while showing the enterprise wedge is real and engineered.

---

## Company

- **Company:** Claude-Mem
- **Website / repo:** https://docs.claude-mem.ai · https://github.com/thedotmack/claude-mem
- **One-liner (B2B framing):** Shared, auditable memory for AI agents across an engineering org.
- **Location:** `[FILL IN]` · **Founder:** Alex Newman (thedotmack@gmail.com)
- **Stage:** Pre-seed; open-source with 77k+ stars; enterprise product in development.

## Is your revenue (or future revenue) from enterprises? (Alchemist's key question)

Yes. The free open-source core drives bottom-up adoption inside engineering teams; monetization
is **B2B**: team plans (shared memory, per seat) and enterprise contracts (SSO/SAML/SCIM, RBAC,
audit-log UI, DLP/policy engine, managed cloud, SLA). The buyer is the engineering org. The
enterprise substrate — multi-tenant Postgres with a per-event identity triad (api key × actor ×
request) and a compliance-grade audit chain — is already built, which is exactly what enterprise
security/compliance review requires.

## What does the company do?

AI coding agents forget everything between sessions, so engineering teams lose context, repeat
decisions, and watch tacit knowledge evaporate. Claude-Mem is a memory layer that captures agent
activity automatically, compresses it into structured observations with an LLM, and injects
relevant memory into future sessions. At org scale it becomes a **shared team brain**: any
engineer (or CI/agent) can search what the team has learned, with every memory attributable,
tenant-isolated, and auditable.

## Why enterprises buy this

- **Onboarding & ramp time:** new engineers query the team's lived knowledge, not stale docs.
- **Knowledge retention:** when people leave, their reasoning persists as attributed observations.
- **Compliance & trust:** every AI-written memory ties to an api key, actor, request, and model —
  revocable and audit-ready (the precondition for enterprises trusting AI-written shared data).
- **Privacy:** `<private>` redaction at the edge; tenant scoping enforced at every layer.
- **Cost & quality:** less re-explaining, better agent output, knowledge that compounds.

## Traction

- 77,854 GitHub stars, 6,706 forks (~9 months, zero paid marketing) — proven developer demand,
  the top of the enterprise funnel.
- Multi-tenant team/enterprise server merged and in beta.
- Distributed via npx, plugin marketplace, npm; active Discord.
- `[FILL IN: downloads/active installs, any enterprise design partners, LOIs, pilot conversations.
  Alchemist values early B2B signal — list any company names or titles you've talked to.]`

## Market & business model

Wedge: AI-coding-agent users (millions). B2B expansion: per-seat team plans → enterprise
contracts. Category: AI agent memory infrastructure (vs. Mem0, Supermemory, Zep, Letta).
Open-core; enterprise revenue is the model.

## Competition / moat

Zero-config harness-layer capture, cross-agent neutrality, 77k-star distribution, and an
enterprise-grade audit/tenant substrate competitors haven't built. Private org memory corpora
compound — switching cost grows with use.

## Team

Alex Newman — founder, creator, primary author; built the full enterprise substrate solo. `[FILL
IN: founder-market fit, enterprise/technical credibility, hiring plan from 00-founder-bio.md.]`

## Ask / use of funds

`[FILL IN: e.g., first enterprise GTM hire, design-partner program, SOC2 path, and the round to
convert OSS adoption into enterprise revenue.]`
