# Accelerator & VC Applications — Claude-Mem

Ready-to-submit application datasets for the programs in the May 2026 "YC extended S26 + save
these too" list. Each file is a self-contained set of answers tailored to that program's actual
application, drawing from a shared, reusable dossier so you only maintain facts once.

**Founder:** Alex Newman (@thedotmack) · **Project:** Claude-Mem · thedotmack@gmail.com

---

## How to use these

1. **Start with the shared files** and fill in every `[FILL IN]`:
   - [`00-company-dossier.md`](00-company-dossier.md) — the master dataset (one-liners, problem,
     solution, traction, market, business model, competition, vision, risks, quick-reference
     table). Update a number here and it applies everywhere.
   - [`00-founder-bio.md`](00-founder-bio.md) — bio variants (1 sentence → 100 words →
     founder-market-fit paragraph). Complete the personal placeholders once.
2. **Open the per-program file**, paste its answers into that program's form, and tighten any
   `[FILL IN]`s the dossier didn't cover.
3. **Verify live numbers** (stars, forks, downloads) on submission day — they change daily.
4. **Record the YC founder video** using the script in `y-combinator-s26.md` (after editing).

---

## Programs (from the post) + portals + cadence

| # | Program | File | Portal | Cadence / deadline |
|---|---------|------|--------|--------------------|
| 1 | **Y Combinator (S26)** | [`y-combinator-s26.md`](y-combinator-s26.md) | https://www.ycombinator.com/apply | **Deadline extended to May 25** — apply now |
| 2 | **Pear VC (PearX)** | [`pear-vc.md`](pear-vc.md) | https://pear.vc/pearx/ | 2 batches/yr, SF; S26 kicks off July |
| 3 | **Creative Destruction Lab** | [`creative-destruction-lab.md`](creative-destruction-lab.md) | https://creativedestructionlab.com/apply/ | 23 streams, equity- & fee-free, apps open |
| 4 | **Antler** | [`antler.md`](antler.md) | https://www.antler.co/apply | Rolling; NYC / Austin / SF |
| 5 | **Plug and Play** | [`plug-and-play.md`](plug-and-play.md) | https://www.plugandplaytechcenter.com/apply | Rolling; vertical tracks; multi-location |
| 6 | **Alchemist Accelerator** | [`alchemist.md`](alchemist.md) | https://alchemistaccelerator.com/apply | B2B/enterprise, SF, 2 batches/yr |
| 7 | **gener8tor** | [`gener8tor.md`](gener8tor.md) | https://www.gener8tor.com/apply | Rolling; 45 cities / 20+ states |
| 8 | **500 Global** | [`500-global.md`](500-global.md) | https://500.co/accelerators | Global, multiple tracks, rolling |
| 9 | **Techstars** | [`techstars.md`](techstars.md) | https://www.techstars.com/apply | Rolling; 6+ cities + remote; next ~June |
| 10 | **South Park Commons** | [`south-park-commons.md`](south-park-commons.md) | https://www.southparkcommons.com/founder-fellowship | Pre-idea/frontier tech, rolling |

> Portal URLs are best-known entry points; confirm each is current before applying. Verify exact
> deadlines on each site — only YC's May 25 date is fixed by the source post.

---

## Positioning cheat-sheet (how each program differs)

- **YC / Pear / 500** — traction & growth machines. Lead with numbers (stars → downloads →
  revenue path) and crisp thinking.
- **Alchemist / Plug and Play** — B2B/enterprise. Lead with the **team/enterprise** product, the
  audit/compliance substrate, and the path to enterprise revenue.
- **Techstars** — **team-first.** Lead with the founder + execution velocity.
- **Antler / South Park Commons** — **founder/person-first.** Lead with your story, edge, and
  frontier thesis; Claude-Mem is the proof, not just the pitch.
- **CDL** — **objective-driven & equity-free.** Lead with defensible technology and measurable
  90-day objectives.

---

## Pre-submission checklist (do once, reuse everywhere)

- [ ] Fill in all `[FILL IN]` in `00-company-dossier.md` and `00-founder-bio.md`.
- [ ] **Numbers (verify live the day you submit):** GitHub stars/forks, npm weekly downloads,
      install/active counts, marketplace installs, Discord size, growth rates.
- [ ] **Revenue/commercial signal:** any paying/waitlisted teams, design partners, LOIs.
- [ ] **Founder details:** location, full bio, prior companies, co-founder status / hiring plan.
- [ ] **Company legal:** incorporated? entity/state? cap table? raised to date? amount raising?
- [ ] **Assets:** demo video/GIF link, logo, headshot, deck (if a program wants one).
- [ ] **YC:** record the 1-minute founder video (script in `y-combinator-s26.md`).
- [ ] **$CMEM token decision:** recommend **omitting** the community Solana token from these
      applications unless directly asked; if asked, frame it as a community/marketing phenomenon
      separate from the company, product, and cap table (see dossier §13).
- [ ] Tailor the per-program "what we want from you / use of funds" ask to each program.

---

## Snapshot (verify live before submitting)

- GitHub: **77,854 stars · 6,706 forks** · Apache-2.0 · TypeScript · created Aug 2025 (~9 months).
- Cross-agent: Claude Code, Cursor, Codex, Gemini CLI, Windsurf, OpenCode, OpenClaw, Copilot,
  Hermes · 28 languages.
- Distribution: `npx claude-mem install`, Claude Code plugin marketplace, npm; active Discord;
  Trendshift feature.
- Commercial: multi-tenant team/enterprise memory server merged and in beta (open-core model).
