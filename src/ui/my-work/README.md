# My Work wireframe

A structural wireframe of the My Work LIVE spec (`.scratch/work-state-spec/SPEC.md`), in React with shadcn/ui and AI Elements. Sample data only. Visual design still goes through image mockups (spec §11).

```bash
npm install
npm run dev        # http://localhost:5173
npm run coverage   # checks every UI requirement is on screen, writes COVERAGE.md
```

## How coverage works

- `src/spec/requirements.ts` lists every requirement in the spec with an id (`R5.6` is §5; `D5` is decision 5 in §15). Each one is marked `ui`, `backend` or `process`.
- Wireframe elements are wrapped in `<Req ids={['R5.6']}>`. Turn on **Show spec IDs** in the top bar to see the ids on screen, and hover one to read the requirement.
- `npm run coverage` fails if a `ui` requirement has no tag, and writes `COVERAGE.md` with where each one appears.

## What's where

| Screen | File | AI Elements used |
| --- | --- | --- |
| My Work: one-line summary, Cards, List, By agent, Team, then today's story | `src/pages/my-work.tsx` | Agent |
| Request card, including the terminal-to-human transform | `src/components/request-card.tsx` | Terminal, Shimmer |
| Request page: next move first, layers collapsed | `src/components/request-detail.tsx` | Chain of Thought, Task, Queue |
| My Goals | `src/pages/my-goals.tsx` | Inline Citation |
| My Rules: decision queue, scopes, replaced history | `src/pages/my-rules.tsx`, sample rules in `src/data-rules.ts` | Confirmation, Inline Citation, Artifact |

The top bar switches between **At home** (localhost) and **On the go** (cmem.ai), which changes the live source, Refresh behavior and where edits are saved from.

## Shared request state

`src/data.ts` `REQUESTS` is the one source of request state. `updateRequest()` replaces an entry in place and checks the lifecycle rules (`assertConsistentRequest`: state, stage, progress and next move must agree), and `useRequests()` re-renders on change, so My Work, the request page and My Goals show the same state. The 7-second demo (`playDemoUpdates`) finishes the wireframe request as one coherent change; "Mark checked" hands a request back to you to ship and never marks it shipped.

Truth rules in the sample: the ship estimate only shows with two or more advancing progress readings (`measuredEstimate`), progress states its review coverage, and work-product links without a real target render as **sample** instead of a dead link. Agent marks and the cmem mark are inlined in `src/components/brand.tsx`. Generation cost is not shown (the owner dropped it on Oct 20, 2026).
