# State a person or an agent can see

Decided 9 November 2026, after reading every source file for state machines.
Most of them are private flags inside one class, and those are fine. The ones
that hurt are the states someone outside the code can see, when the list of
states was typed out again in each place that shows it.

## Contract

A state is seen when it is shown in the viewer, My Work or a CLI command, put
in a hook message or the SessionStart context, returned by an MCP tool, sent
over HTTP or SSE, or stored in a file or column that another process reads.

Every such state has one definition. Everything else imports it.

- The definition lives with the code that writes the state. When two programs
  must agree on it (the worker and My Work, the installer and the worker), it
  lives in a module both can load.
- Types, request checks, label tables and tests take the list from the
  definition. A request check uses `z.enum(THE_LIST)`. A UI type is an alias of
  the shared type. None of them types the values again.
- A table that words a state for people is a `Record<State, …>`. A new state
  then fails the typecheck until every screen has words for it, so no screen
  falls back to a raw identifier or to nothing.
- A machine with more than two states carries its moves as a small diagram in
  the comment on its type, and names its one writer.
- A rule about a state (which statuses close an item, which phases count as
  running) is one function. Callers ask it; they do not restate the list.
- A state that is written and never read, or read and never written, is
  deleted. It is not documented and kept.

Do not add a state-machine library, a transition framework or a registry.
A named union, a comment and the compiler are enough, and they cannot change
what the program does at run time.

## What it looks like here

| State | The one definition | Who takes it from there |
| --- | --- | --- |
| Worker boot phase | `InitPhase` in `src/services/server/init-phase.ts` | the tracker, its one writer, and the `/api/ready` stream |
| Auto-clear phase | `Phase` in `src/mods/auto-clear/controller.ts` | the controller, its one writer |
| Setup flow: branch, billing, installer stage, checkout, scan phase, history import | `src/shared/setup-funnel.ts` | installer, worker files and request checks, setup page |
| Dependency status and its wording | `DEPENDENCY_STATUS_LABELS` in `src/shared/dependency-health.ts` | `claude-mem status`, `claude-mem doctor` |
| Which work-state statuses close an item | `isClosedWorkStateStatus` in `src/services/work-view/work-state-status.mjs` | SessionStart section, work-state tool replies, My Work, owner-goals readers, the write route |
| Refresh run state | `WorkViewRefreshState` in `src/ui/my-work/src/live/work-view-api-types.ts` | every My Work screen that shows a run |
| Rule status, focus area status | `SavedRule['status']` in `my-rules.d.mts`, `FocusAreaStatus` in `my-focus.d.mts` | My Work wire types and UI model |

My Work compiles on its own settings and cannot load every worker file. A
shared state for it goes in a module with no Node imports
(`src/shared/setup-funnel.ts` is the model). Where even that is not possible,
keep the restated type and add a line in a root-checked file that fails the
typecheck when the two differ, as `MEDIA_TYPES_AGREE` does in
`src/services/work-view/overview.ts`.

A `.mjs` module and its `.d.mts` declaration state a list twice by nature: once
as values, once as a type. Keep the pair in step by hand, and let everything
else take the type from the declaration.

## Proof to ask for

Add a throwaway value to the definition and run the three typechecks
(`npm run typecheck`, and `npx tsc -b` in `src/ui/my-work`). The compile must
fail at each place that words or checks the state. If it passes, a copy of the
list still exists somewhere; find it and make it import the definition.

A change that only moves a type to its one definition must leave the built
bundles byte for byte the same. A change that also fixes a copy that had
drifted needs a test that fails on the old code.
