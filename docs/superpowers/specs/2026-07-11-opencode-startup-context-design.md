# OpenCode Startup Context Design

## Problem

The OpenCode integration writes claude-mem context to the global `AGENTS.md` only during installation. It does not register OpenCode's system-prompt transform hook, so the context becomes stale. It also uses `ctx.project.name || "opencode"`; the installed OpenCode SDK does not reliably expose `project.name`, causing unrelated directories to share the `opencode` project.

## Design

- Derive the memory project from `ctx.directory` with claude-mem's existing `getProjectContext` helper. This preserves its git-root and worktree behavior.
- Mark newly initialized sessions with `platformSource: "opencode"`.
- Register `experimental.chat.system.transform` and append context returned by `/api/context/inject` to `output.system`.
- Query both the current project and the legacy `opencode` project so existing persisted OpenCode history remains available.
- Cache the fetched context by OpenCode session ID, but append the cached value on every system-prompt build because OpenCode reconstructs the system prompt for each model request.
- Remove cache entries when OpenCode reports `session.deleted` and cap the cache with the same bounded-map approach used by session capture.
- Treat an unavailable worker as non-fatal and leave the system prompt unchanged.
- Remove the stale claude-mem block from global `AGENTS.md` after installing the dynamic hook. Preserve all unrelated global instructions.

## Agent Scope

The system transform is a global OpenCode plugin hook. It applies to primary agents, subagents, and internal OpenCode model calls. Sessions with distinct IDs receive independently cached startup context.

## Testing

- Assert the system-transform hook is part of the registered OpenCode contract.
- Assert context is requested for the directory-derived project plus the legacy project.
- Assert the rendered context is appended to the system prompt on repeated builds while fetched once per session.
- Assert worker failure leaves the prompt unchanged.
- Run the focused integration test, typecheck, rebuild the OpenCode bundle, install it, and verify a clean OpenCode process receives dynamic context.
