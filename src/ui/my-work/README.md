# My Work worker UI

The released worker's My Work MVP, in React with shadcn/ui and AI Elements. It reads the local worker at `localhost:37777` and stays current through server-sent events. `?source=sample` explicitly selects the design fixtures; a failed live read never falls back to sample data.

```bash
npm install
npm run dev        # http://localhost:5173
npm run coverage   # checks every UI requirement is on screen, writes COVERAGE.md
npm test           # mapping, transport, store and setup regressions
npm run build      # typecheck and bundle into plugin/ui/work-view
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

The sample top bar demonstrates **At home** and **On the go**. In live mode the source determines the workspace; cloud transport is not implemented here.

## Shared state and live updates

`src/stores/work-store.ts` owns the current worker model in Zustand. Every page reads that model through `src/data.ts`; requests, goals, rules and the open drawer update together. Source sessions fence initial reads, refreshes and saves so an old session cannot replace current work. Heartbeats update the connection state separately from the model, avoiding full-page renders each second. Failed startup reads offer Retry; reconnects keep the last received work visible.

`src/stores/view-store.ts` owns navigation, selection, theme and view preferences. The URL carries page/request/goal navigation, including Back/Forward and reload. Versioned browser storage holds validated display preferences only, never copies of private work or pending writes. Forms and disclosures keep their temporary state locally.

The October 2026 state audit fixed three additional gaps: snapshot comparison omitted story/device fields; delayed save responses could replace newer SSE content; and changes to the rules-file import were not broadcast to other tabs. Transport regression tests cover stale reads/writes, full snapshot delivery, disposal and reconnects. Route tests cover rules-file events.

The sample demo (`playDemoUpdates`) runs only against explicit fixtures. "Mark checked" saves a check of the displayed content fingerprint through the worker; it never marks work shipped.

Truth rules in the sample: the ship estimate only shows with two or more advancing progress readings (`measuredEstimate`), progress states its review coverage, and work-product links without a real target render as **sample** instead of a dead link. Agent marks and the cmem mark are inlined in `src/components/brand.tsx`. Generation cost is not shown (the owner dropped it on Oct 20, 2026).
