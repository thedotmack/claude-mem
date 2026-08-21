# FACE CARD

An interactive cinematic app where the user is the main character. Answer nine
questions, get a Face Card, then play a branching AI-directed movie where every
choice permanently changes the story.

> Your face. Your choices. Your movie.

## Stack

| Layer | Choice |
| --- | --- |
| App | Next.js (App Router) + React + TypeScript |
| Styling | Tailwind CSS v4 + a custom liquid-glass design system |
| Database / Auth / Storage | Supabase (Postgres + RLS, Auth, Storage) |
| Hosting | Vercel |

## Architecture

```
answers → Face Card → character bible → story state
                                            │
                        ┌───────────────────┘
                        ▼
        composeScene()  →  job pipeline  →  scene
        (branching graph)  SCRIPT → VISUALS → VOICE → AUDIO → FINAL CUT
                        ▲                       │
                        └──── updated state ◄── player choice
```

### The story engine (`src/lib/engine/`)

- **`types.ts`** — the shared narrative contract.
- **`emotions.ts`** — 11 hidden emotional variables. The dominant emotion selects
  a full cinematography look (framing, camera move, lighting, palette, grain,
  vignette, tempo). Emotion is expressed through direction, never a stats panel.
- **`questions.ts`** — character creation. Every answer carries emotion deltas,
  stat bias, and trait tags.
- **`facecard.ts`** — stats, archetype selection, signature line, and the Face
  Card score. **The score rates presentation/style, not the person** — a
  decisive, sharply-defined character scores high whether heroic or awful.
- **`bible.ts`** — the cinematic character bible driving voice and consistency.
- **`story.ts`** — state machine. Choices carry explicit `effects` (emotions,
  flags, relationships, inventory, memory, branch tokens, unlocks).
- **`templates.ts`** — story worlds as beat graphs. Beats and choices are gated
  by `when` predicates, so different paths genuinely reach different scenes.
- **`endings.ts`** — endings resolved rarest-first by predicate. Secret endings
  require specific combinations and are never exposed to the client.

Two guarantees the engine enforces:

1. **No fake choices.** If predicates filter a decision down to a single option,
   the scene plays straight through instead of faking a fork.
2. **The story remembers.** Choices write memory entries that resurface as
   callbacks in later scenes, and characters' trust/affinity persist.

### Provider abstraction (`src/lib/ai/`)

Nothing is hard-coded to one vendor. Each capability resolves an adapter at call
time from environment configuration, and **every capability ships a working
built-in engine**, so the app is fully functional with zero API keys:

| Capability | Built-in (no key) | Hosted options |
| --- | --- | --- |
| LLM | deterministic narrative engine | Anthropic, OpenAI |
| Image | procedural cinematic frame renderer (SVG) | fal, Replicate |
| Video | motion director (camera move applied to the still) | fal |
| Voice | Web Speech synthesis on-device | ElevenLabs |
| Music | procedural WebAudio score keyed to emotion | — |
| Moderation | server-side ruleset | OpenAI |

When an LLM key is present it may only **rewrite how lines sound** — the branching
structure always comes from the deterministic engine, so plot logic can never be
hallucinated away. Every hosted call falls back to the built-in engine on
failure, so a provider outage degrades quality but never breaks a story.

**Credentials are read server-side only** (`src/lib/env.ts` + `server-only`) and
never reach the browser.

### Async generation (`src/lib/jobs.ts`)

Scenes generate through a Postgres-backed job queue with per-stage status, so the
player watches `SCRIPT → VISUALS → VOICE → AUDIO → FINAL CUT → PLAY`. Jobs retry,
and the progress poller is self-healing: if a background run never started, or
failed retryably, polling picks it back up. A permanently failed job never
destroys the story — the scene stays resumable.

Generated assets are uploaded to Supabase Storage under `{userId}/…` and served
from durable public URLs, never temporary blob URLs.

### Security

- Row Level Security on all 22 tables is the security boundary.
- **No service-role key is used anywhere.** Privileged operations go through
  audited `SECURITY DEFINER` functions (`award_xp`, `increment_movie_views`,
  `record_usage`, `usage_today`).
- `story_states`, `emotional_states` and `relationships` are strictly private, so
  the hidden variables and ending tree can't be read by other players.
- All input is validated server-side with Zod, and answers are re-validated
  against the server's own question bank rather than trusted from the client.
- Storage policies restrict writes to the uploader's own folder; buckets enforce
  MIME type and file-size limits.

### Cost control

`usage_events` meters every generation with provider, model, estimated cost and
duration. `app_settings.limits` holds configurable daily caps (scenes, stories,
spend, and max scenes per story) enforced before any generation runs, which also
prevents runaway generation loops. Operators tune them live at `/admin`.

## Local development

```bash
npm install
cp .env.example .env.local     # fill in your Supabase project values
npm run dev
```

Only the two `NEXT_PUBLIC_SUPABASE_*` values are required. Every AI provider is
optional — omit them all and the built-in engines run.

Apply `supabase/migrations/*.sql` to your Supabase project before first run.

## Routes

| Path | Purpose |
| --- | --- |
| `/` | Cinematic cold open |
| `/signup`, `/login`, `/reset` | Auth (email/password + Google) |
| `/create` | Character creation → Face Card |
| `/play/[id]` | The movie player |
| `/m/[id]` | Public movie / share / remix page |
| `/feed` | Discovery feed + trending premises |
| `/me`, `/u/[username]` | Profiles |
| `/admin` | Operator controls (admin only) |
| `/api/health` | Liveness + provider wiring |
