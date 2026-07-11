# OpenCode Startup Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dynamically inject directory-scoped claude-mem context into every OpenCode agent system prompt while preserving access to existing `opencode` history.

**Architecture:** Extend the existing OpenCode plugin rather than maintaining a fork. Resolve project identity with claude-mem's shared git/worktree-aware helper, cache successful context responses by OpenCode session, append the cached text during every system-prompt build, and retain the legacy `opencode` project in context queries for persisted data compatibility.

**Tech Stack:** TypeScript, Bun test runner, OpenCode plugin API, claude-mem worker HTTP API, esbuild.

## Global Constraints

- Apply to all OpenCode agents, including primary agents, subagents, and internal model calls.
- Do not make worker availability a prerequisite for OpenCode model requests.
- Preserve all non-claude-mem content in global `AGENTS.md`.
- Preserve access to existing observations stored under project `opencode` and platform `claude`.
- Do not modify unrelated dirty files already present in the marketplace checkout.

---

### Task 1: Dynamic System Context and Project Identity

**Files:**
- Modify: `tests/integrations/opencode-plugin-contract.test.ts`
- Modify: `src/integrations/opencode-plugin/index.ts`

**Interfaces:**
- Consumes: `getProjectContext(cwd: string | null | undefined): ProjectContext` and worker `GET /api/context/inject?projects=...`.
- Produces: OpenCode hook `experimental.chat.system.transform(input, output): Promise<void>` and directory-derived session initialization.

- [ ] **Step 1: Add failing contract tests**

Add `experimental.chat.system.transform` to `REAL_OPENCODE_HOOK_NAMES`, assert it is registered, and add these test cases:

```ts
it("injects directory-scoped context into every system prompt build", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response("# remembered context", { status: 200 });
  }) as typeof fetch;

  try {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const transform = plugin["experimental.chat.system.transform"];
    const first = { system: ["base"] };
    const second = { system: ["base"] };
    await transform({ sessionID: "context-session", model: {} as never }, first);
    await transform({ sessionID: "context-session", model: {} as never }, second);

    expect(first.system).toEqual(["base", "# remembered context"]);
    expect(second.system).toEqual(["base", "# remembered context"]);
    expect(requests.filter((url) => url.includes("/api/context/inject"))).toHaveLength(1);
    expect(requests[0]).toContain("projects=x%2Copencode");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("marks initialized sessions as OpenCode", async () => {
  // Capture the /api/sessions/init body through the existing fetch stub.
  expect((initPost!.body as Record<string, unknown>).project).toBe("x");
  expect((initPost!.body as Record<string, unknown>).platformSource).toBe("opencode");
});
```

Keep the existing `pluginCtx.directory` value `/tmp/x`; `getProjectContext` deterministically falls back to the basename `x` when that path is not a git repository. Leave `pluginCtx.project.name` as `test-project` so the assertion proves it is ignored.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run: `rtk bun test tests/integrations/opencode-plugin-contract.test.ts`

Expected: FAIL because `experimental.chat.system.transform` is absent and session initialization lacks `platformSource`.

- [ ] **Step 3: Implement the minimal plugin change**

In `src/integrations/opencode-plugin/index.ts`:

```ts
import { getProjectContext } from "../../utils/project-name.js";

export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "experimental.chat.system.transform",
] as const;

const contextBySessionId = new Map<string, string>();

function buildContextProjects(directory: string): { projectName: string; projects: string[] } {
  const projectContext = getProjectContext(directory);
  return {
    projectName: projectContext.primary,
    projects: [...new Set([...projectContext.allProjects, "opencode"])],
  };
}
```

Change session initialization to send:

```ts
workerPostFireAndForget("/api/sessions/init", {
  contentSessionId,
  project: projectName,
  platformSource: "opencode",
  prompt: "",
});
```

Resolve the project once in `ClaudeMemPlugin` and add the hook:

```ts
const { projectName, projects } = buildContextProjects(ctx.directory);

"experimental.chat.system.transform": async (
  input: { sessionID?: string },
  output: { system: string[] },
): Promise<void> => {
  const cacheKey = input.sessionID || `project:${projectName}`;
  let context = contextBySessionId.get(cacheKey);
  if (!context) {
    const projectsParam = projects.join(",");
    context = await workerGetText(
      `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`,
    ) || undefined;
    if (context) {
      while (contextBySessionId.size >= MAX_SESSION_MAP_ENTRIES) {
        const oldestKey = contextBySessionId.keys().next().value;
        if (oldestKey === undefined) break;
        contextBySessionId.delete(oldestKey);
      }
      contextBySessionId.set(cacheKey, context);
    }
  }
  if (context) output.system.push(context);
},
```

Delete `contextBySessionId` entries for deleted sessions alongside the existing capture maps.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `rtk bun test tests/integrations/opencode-plugin-contract.test.ts`

Expected: all focused tests PASS.

Run: `rtk npm run typecheck:root`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 5: Commit the source and test change**

```bash
rtk git add src/integrations/opencode-plugin/index.ts tests/integrations/opencode-plugin-contract.test.ts
rtk git commit -m "fix: inject project context into OpenCode agents"
```

---

### Task 2: Build and Install the Patched Plugin

**Files:**
- Modify generated artifact: `dist/opencode-plugin/index.js`
- Replace installed artifact: `~/.config/opencode/plugins/claude-mem.js`
- Modify user instructions: `~/.config/opencode/AGENTS.md`

**Interfaces:**
- Consumes: tested TypeScript plugin entrypoint from Task 1.
- Produces: the plugin artifact loaded by OpenCode at process startup.

- [ ] **Step 1: Build only the OpenCode plugin artifact**

Use the same esbuild options as `scripts/build-hooks.js` for `src/integrations/opencode-plugin/index.ts`, avoiding the full build because unrelated generated artifacts are already dirty.

Run:

```bash
rtk node -e 'import("esbuild").then(({build}) => build({entryPoints:["src/integrations/opencode-plugin/entry.ts"],bundle:true,platform:"node",target:"node18",format:"esm",outfile:"dist/opencode-plugin/index.js",minify:true,logLevel:"error",external:["fs","fs/promises","path","os","child_process","url","crypto","http","https","net","stream","util","events"]}))'
```

Expected: `dist/opencode-plugin/index.js` is regenerated without changing unrelated worker/UI bundles.

- [ ] **Step 2: Install the generated artifact**

Copy `dist/opencode-plugin/index.js` to `~/.config/opencode/plugins/claude-mem.js` using a normal filesystem copy command.

Expected: both files have identical SHA-256 hashes.

- [ ] **Step 3: Remove only the obsolete static context block**

Delete the range from `<claude-mem-context>` through `</claude-mem-context>` in `~/.config/opencode/AGENTS.md`. Preserve Global OpenCode Rules, CodeGraph, and RTK instructions byte-for-byte outside the surrounding blank-line normalization.

- [ ] **Step 4: Validate configuration and artifacts**

Run: `rtk opencode --version`

Expected: OpenCode starts configuration loading successfully and reports its version.

Run: compare SHA-256 hashes for the generated and installed plugin files.

Expected: hashes match.

---

### Task 3: Installed-Artifact Verification

**Files:**
- Verify only: `~/.config/opencode/plugins/claude-mem.js`
- Verify only: `~/.claude-mem/claude-mem.db`

**Interfaces:**
- Consumes: installed plugin artifact and healthy claude-mem worker.
- Produces: evidence that context and capture use the current directory project.

- [ ] **Step 1: Verify the installed plugin in an isolated hook harness**

Import `~/.config/opencode/plugins/claude-mem.js` from a temporary Bun test script, replace `globalThis.fetch` with a recording stub, initialize the plugin with directory `/tmp/startup-context-project`, and invoke `experimental.chat.system.transform` using session IDs `primary-session` and `subagent-session`.

Expected: both outputs contain the stubbed context; one worker context request is made per distinct session; both requests contain `projects=startup-context-project%2Copencode`.

- [ ] **Step 2: Verify dynamic context request behavior**

Invoke the installed hook twice for `primary-session` in the same harness.

Expected: the context appears on both reconstructed system-prompt outputs while the worker is fetched only once for that session.

- [ ] **Step 3: Verify all-agent behavior**

Compare the installed hook outputs for `primary-session` and `subagent-session`.

Expected: each distinct session receives the same project-scoped startup context through the global `experimental.chat.system.transform` hook. The hook contract has no agent filter, so this covers primary agents, subagents, and internal calls.

- [ ] **Step 4: Verify capture classification**

Query SQLite after a fresh captured tool call:

```sql
SELECT project, platform_source, COUNT(*)
FROM sdk_sessions
GROUP BY project, platform_source;
```

Expected: a new row uses the directory-derived project and `platform_source = 'opencode'`; legacy `opencode`/`claude` rows remain unchanged.

- [ ] **Step 5: Run final regression checks**

Run: `rtk bun test tests/integrations/opencode-plugin-contract.test.ts tests/integration/opencode-installer.test.ts`

Expected: all tests PASS.

Run: `rtk npx --yes claude-mem@13.10.2 doctor`

Expected: all required checks PASS.

- [ ] **Step 6: Require an OpenCode restart**

Do not terminate the OpenCode process executing this plan. Report that the installed config-time plugin will become active after the user quits and restarts OpenCode.
